import json
from datetime import datetime
from typing import (
    Any,
    Callable,
    Dict,
    List,
    Optional,
    Tuple,
    Type,
    Union,
    cast,
)

from django.db.models import Prefetch
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiExample, OpenApiParameter
from rest_framework import request, response, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound
from rest_framework.pagination import LimitOffsetPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.settings import api_settings
from rest_framework.utils.serializer_helpers import ReturnDict
from rest_framework_csv import renderers as csvrenderers
from statshog.defaults.django import statsd

from posthog.api.capture import capture_internal
from posthog.api.documentation import PersonPropertiesSerializer, extend_schema
from posthog.api.routing import PKorUUIDViewSet, StructuredViewSetMixin
from posthog.api.utils import format_paginated_url, get_pk_or_uuid, get_target_entity
from posthog.client import sync_execute
from posthog.constants import (
    CSV_EXPORT_LIMIT,
    INSIGHT_FUNNELS,
    INSIGHT_PATHS,
    LIMIT,
    OFFSET,
    TRENDS_TABLE,
    FunnelVizType,
)
from posthog.decorators import cached_function
from posthog.logging.timing import timed
from posthog.models import Cohort, Filter, Person, User
from posthog.models.activity_logging.activity_log import Change, Detail, Merge, load_activity, log_activity
from posthog.models.activity_logging.activity_page import activity_page_response
from posthog.models.cohort.util import get_all_cohort_ids_by_person_uuid
from posthog.models.filters.path_filter import PathFilter
from posthog.models.filters.retention_filter import RetentionFilter
from posthog.models.filters.stickiness_filter import StickinessFilter
from posthog.models.person.sql import GET_PERSON_PROPERTIES_COUNT
from posthog.models.person.util import delete_ch_distinct_ids, delete_person
from posthog.permissions import ProjectMembershipNecessaryPermissions, TeamMemberAccessPermission
from posthog.queries.actor_base_query import ActorBaseQuery, get_people
from posthog.queries.funnels import ClickhouseFunnelActors, ClickhouseFunnelTrendsActors
from posthog.queries.funnels.funnel_strict_persons import ClickhouseFunnelStrictActors
from posthog.queries.funnels.funnel_unordered_persons import ClickhouseFunnelUnorderedActors
from posthog.queries.paths import PathsActors
from posthog.queries.person_query import PersonQuery
from posthog.queries.property_values import get_person_property_values_for_key
from posthog.queries.retention import Retention
from posthog.queries.stickiness import Stickiness
from posthog.queries.trends.lifecycle import Lifecycle
from posthog.queries.util import get_earliest_timestamp
from posthog.settings import EE_AVAILABLE
from posthog.tasks.split_person import split_person
from posthog.utils import convert_property_value, format_query_params_absolute_url, is_anonymous_id, relative_date_parse


class PersonLimitOffsetPagination(LimitOffsetPagination):
    def get_paginated_response_schema(self, schema):
        return {
            "type": "object",
            "properties": {
                "next": {
                    "type": "string",
                    "nullable": True,
                    "format": "uri",
                    "example": "https://app.posthog.com/api/projects/{project_id}/accounts/?offset=400&limit=100",
                },
                "previous": {
                    "type": "string",
                    "nullable": True,
                    "format": "uri",
                    "example": "https://app.posthog.com/api/projects/{project_id}/accounts/?offset=400&limit=100",
                },
                "results": schema,
            },
        }


def get_person_name(person: Person) -> str:
    if person.properties.get("email"):
        return person.properties["email"]
    if len(person.distinct_ids) > 0:
        # Prefer non-UUID distinct IDs (presumably from user identification) over UUIDs
        return sorted(person.distinct_ids, key=is_anonymous_id)[0]
    return person.pk


class PersonSerializer(serializers.HyperlinkedModelSerializer):
    name = serializers.SerializerMethodField()

    class Meta:
        model = Person
        fields = [
            "id",
            "name",
            "distinct_ids",
            "properties",
            "created_at",
            "uuid",
        ]
        read_only_fields = ("id", "name", "distinct_ids", "created_at", "uuid")

    def get_name(self, person: Person) -> str:
        return get_person_name(person)

    def to_representation(self, instance: Person) -> Dict[str, Any]:
        representation = super().to_representation(instance)
        representation["distinct_ids"] = sorted(representation["distinct_ids"], key=is_anonymous_id)
        return representation


def should_paginate(results, limit: Union[str, int]) -> bool:
    return len(results) > int(limit) - 1


def get_funnel_actor_class(filter: Filter) -> Callable:
    funnel_actor_class: Type[ActorBaseQuery]

    if filter.correlation_person_entity and EE_AVAILABLE:

        if EE_AVAILABLE:
            from ee.clickhouse.queries.funnels.funnel_correlation_persons import FunnelCorrelationActors

            funnel_actor_class = FunnelCorrelationActors
        else:
            raise ValueError(
                "Funnel Correlations is not available without an enterprise license and enterprise supported deployment"
            )
    elif filter.funnel_viz_type == FunnelVizType.TRENDS:
        funnel_actor_class = ClickhouseFunnelTrendsActors
    else:
        if filter.funnel_order_type == "unordered":
            funnel_actor_class = ClickhouseFunnelUnorderedActors
        elif filter.funnel_order_type == "strict":
            funnel_actor_class = ClickhouseFunnelStrictActors
        else:
            funnel_actor_class = ClickhouseFunnelActors

    return funnel_actor_class


class PersonViewSet(PKorUUIDViewSet, StructuredViewSetMixin, viewsets.ModelViewSet):
    renderer_classes = tuple(api_settings.DEFAULT_RENDERER_CLASSES) + (csvrenderers.PaginatedCSVRenderer,)
    queryset = Person.objects.all()
    serializer_class = PersonSerializer
    pagination_class = PersonLimitOffsetPagination
    permission_classes = [IsAuthenticated, ProjectMembershipNecessaryPermissions, TeamMemberAccessPermission]
    lifecycle_class = Lifecycle
    retention_class = Retention
    stickiness_class = Stickiness

    def get_queryset(self):
        queryset = super().get_queryset()
        queryset = queryset.prefetch_related(Prefetch("persondistinctid_set", to_attr="distinct_ids_cache"))
        queryset = queryset.only("id", "created_at", "properties", "uuid", "is_identified")
        return queryset

    @extend_schema(
        parameters=[
            OpenApiParameter(
                "email",
                OpenApiTypes.STR,
                description="Filter persons by email (exact match)",
                examples=[OpenApiExample(name="email", value="test@test.com")],
            ),
            OpenApiParameter("distinct_id", OpenApiTypes.INT, description="Filter list by distinct id."),
            OpenApiParameter(
                "search",
                OpenApiTypes.STR,
                description="Search persons, either by email (full text search) or distinct_id (exact match).",
            ),
            PersonPropertiesSerializer(required=False),
        ],
    )
    def list(self, request: request.Request, *args: Any, **kwargs: Any) -> response.Response:
        team = self.team
        filter = Filter(request=request, team=self.team)

        is_csv_request = self.request.accepted_renderer.format == "csv"
        if is_csv_request:
            filter = filter.with_data({LIMIT: CSV_EXPORT_LIMIT, OFFSET: 0})
        elif not filter.limit:
            filter = filter.with_data({LIMIT: 100})

        query, params = PersonQuery(filter, team.pk).get_query(paginate=True)

        raw_result = sync_execute(query, params)

        actor_ids = [row[0] for row in raw_result]
        actors, serialized_actors = get_people(team.pk, actor_ids)

        _should_paginate = should_paginate(actor_ids, filter.limit)
        next_url = format_query_params_absolute_url(request, filter.offset + filter.limit) if _should_paginate else None
        previous_url = (
            format_query_params_absolute_url(request, filter.offset - filter.limit)
            if filter.offset - filter.limit >= 0
            else None
        )

        return Response({"results": serialized_actors, "next": next_url, "previous": previous_url})

    def destroy(self, request: request.Request, pk=None, **kwargs):  # type: ignore
        try:
            person = self.get_object()
            person_id = person.id

            delete_person(person=person)
            delete_ch_distinct_ids(
                person_uuid=str(person.uuid), distinct_ids=person.distinct_ids, team_id=person.team_id
            )
            person.delete()

            log_activity(
                organization_id=self.organization.id,
                team_id=self.team_id,
                user=request.user,  # type: ignore
                item_id=person_id,
                scope="Person",
                activity="deleted",
                detail=Detail(name=str(person_id)),
            )

            return response.Response(status=204)
        except Person.DoesNotExist:
            raise NotFound(detail="Person not found.")

    @action(methods=["GET", "POST"], detail=False)
    def funnel(self, request: request.Request, **kwargs) -> response.Response:
        if request.user.is_anonymous or not self.team:
            return response.Response(data=[])

        results_package = self.calculate_funnel_persons(request)

        if not results_package:
            return response.Response(data=[])

        people, next_url, initial_url = results_package["result"]

        return response.Response(
            data={
                "results": [{"people": people, "count": len(people)}],
                "next": next_url,
                "initial": initial_url,
                "is_cached": results_package.get("is_cached"),
                "last_refresh": results_package.get("last_refresh"),
            }
        )

    @cached_function
    def calculate_funnel_persons(
        self, request: request.Request
    ) -> Dict[str, Tuple[List, Optional[str], Optional[str]]]:
        if request.user.is_anonymous or not self.team:
            return {"result": ([], None, None)}

        filter = Filter(request=request, data={"insight": INSIGHT_FUNNELS}, team=self.team)
        if not filter.limit:
            filter = filter.with_data({LIMIT: 100})

        funnel_actor_class = get_funnel_actor_class(filter)

        actors, serialized_actors = funnel_actor_class(filter, self.team).get_actors()
        _should_paginate = should_paginate(actors, filter.limit)
        next_url = format_query_params_absolute_url(request, filter.offset + filter.limit) if _should_paginate else None
        initial_url = format_query_params_absolute_url(request, 0)

        # cached_function expects a dict with the key result
        return {"result": (serialized_actors, next_url, initial_url)}

    @action(methods=["GET"], detail=False)
    def properties(self, request: request.Request, **kwargs) -> response.Response:
        result = self.get_properties(request)

        return response.Response(result)

    def get_properties(self, request: request.Request):
        rows = sync_execute(GET_PERSON_PROPERTIES_COUNT, {"team_id": self.team.pk})
        return [{"name": name, "count": count} for name, count in rows]

    @action(methods=["GET", "POST"], detail=False)
    def path(self, request: request.Request, **kwargs) -> response.Response:
        if request.user.is_anonymous or not self.team:
            return response.Response(data=[])

        results_package = self.calculate_path_persons(request)

        if not results_package:
            return response.Response(data=[])

        people, next_url, initial_url = results_package["result"]

        return response.Response(
            data={
                "results": [{"people": people, "count": len(people)}],
                "next": next_url,
                "initial": initial_url,
                "is_cached": results_package.get("is_cached"),
                "last_refresh": results_package.get("last_refresh"),
            }
        )

    @cached_function
    def calculate_path_persons(self, request: request.Request) -> Dict[str, Tuple[List, Optional[str], Optional[str]]]:
        if request.user.is_anonymous or not self.team:
            return {"result": ([], None, None)}

        filter = PathFilter(request=request, data={"insight": INSIGHT_PATHS}, team=self.team)
        if not filter.limit:
            filter = filter.with_data({LIMIT: 100})

        funnel_filter = None
        funnel_filter_data = request.GET.get("funnel_filter") or request.data.get("funnel_filter")
        if funnel_filter_data:
            if isinstance(funnel_filter_data, str):
                funnel_filter_data = json.loads(funnel_filter_data)
            funnel_filter = Filter(data={"insight": INSIGHT_FUNNELS, **funnel_filter_data}, team=self.team)

        people, serialized_actors = PathsActors(filter, self.team, funnel_filter=funnel_filter).get_actors()
        _should_paginate = should_paginate(people, filter.limit)

        next_url = format_query_params_absolute_url(request, filter.offset + filter.limit) if _should_paginate else None
        initial_url = format_query_params_absolute_url(request, 0)

        # cached_function expects a dict with the key result
        return {"result": (serialized_actors, next_url, initial_url)}

    @action(methods=["GET"], detail=False)
    def values(self, request: request.Request, **kwargs) -> response.Response:
        key = request.GET.get("key")
        value = request.GET.get("value")
        flattened = []
        if key:
            result = self._get_person_property_values_for_key(key, value)

            for (value, count) in result:
                try:
                    # Try loading as json for dicts or arrays
                    flattened.append({"name": convert_property_value(json.loads(value)), "count": count})  # type: ignore
                except json.decoder.JSONDecodeError:
                    flattened.append({"name": convert_property_value(value), "count": count})
        return response.Response(flattened)

    @timed("get_person_property_values_for_key_timer")
    def _get_person_property_values_for_key(self, key, value):
        try:
            result = get_person_property_values_for_key(key, self.team, value)
            statsd.incr(
                "get_person_property_values_for_key_success", tags={"team_id": self.team.id},
            )
        except Exception as e:
            statsd.incr(
                "get_person_property_values_for_key_error",
                tags={"error": str(e), "key": key, "value": value, "team_id": self.team.id},
            )
            raise e

        return result

    @action(methods=["POST"], detail=True)
    def merge(self, request: request.Request, pk=None, **kwargs) -> response.Response:
        people = Person.objects.filter(team_id=self.team_id, uuid__in=request.data.get("uuids"))
        person = self.get_object()
        person.merge_people([p for p in people])

        data = PersonSerializer(person).data
        for p in people:
            for distinct_id in p.distinct_ids:
                data["distinct_ids"].append(distinct_id)

            log_activity(
                organization_id=self.organization.id,
                team_id=self.team_id,
                user=request.user,  # type: ignore
                item_id=p.id,
                scope="Person",
                activity="was_merged_into_person",
                detail=Detail(
                    merge=Merge(type="Person", source=PersonSerializer(p).data, target=PersonSerializer(person).data,)
                ),
            )

        log_activity(
            organization_id=self.organization.id,
            team_id=self.team_id,
            user=request.user,  # type: ignore
            item_id=person.id,
            scope="Person",
            activity="people_merged_into",
            detail=Detail(
                merge=Merge(
                    type="Person",
                    source=[PersonSerializer(p).data for p in people],
                    target=PersonSerializer(person).data,
                ),
            ),
        )

        return response.Response(data, status=201)

    @action(methods=["POST"], detail=True)
    def split(self, request: request.Request, pk=None, **kwargs) -> response.Response:
        person: Person = self.get_object()
        distinct_ids = person.distinct_ids

        split_person.delay(person.id, request.data.get("main_distinct_id", None))

        log_activity(
            organization_id=self.organization.id,
            team_id=self.team.id,
            user=request.user,  # type: ignore
            item_id=person.id,
            scope="Person",
            activity="split_person",
            detail=Detail(changes=[Change(type="Person", action="split", after={"distinct_ids": distinct_ids})]),
        )

        return response.Response({"success": True}, status=201)

    @action(methods=["POST"], detail=True)
    def delete_property(self, request: request.Request, pk=None, **kwargs) -> response.Response:
        person: Person = get_pk_or_uuid(Person.objects.filter(team_id=self.team_id), pk).get()

        capture_internal(
            distinct_id=person.distinct_ids[0],
            ip=None,
            site_url=None,
            team_id=self.team_id,
            now=datetime.now(),
            sent_at=None,
            event={
                "event": "$delete_person_property",
                "properties": {"$unset": [request.data["$unset"]]},
                "distinct_id": person.distinct_ids[0],
                "timestamp": datetime.now().isoformat(),
            },
        )

        log_activity(
            organization_id=self.organization.id,
            team_id=self.team.id,
            user=request.user,  # type: ignore
            item_id=person.id,
            scope="Person",
            activity="delete_property",
            detail=Detail(changes=[Change(type="Person", action="changed")]),
        )

        return response.Response({"success": True}, status=201)

    @action(methods=["GET"], detail=False)
    def lifecycle(self, request: request.Request) -> response.Response:

        team = cast(User, request.user).team
        if not team:
            return response.Response(
                {"message": "Could not retrieve team", "detail": "Could not validate team associated with user"},
                status=400,
            )

        filter = Filter(request=request, team=self.team)
        target_date = request.GET.get("target_date", None)
        if target_date is None:
            return response.Response(
                {"message": "Missing parameter", "detail": "Must include specified date"}, status=400
            )
        target_date_parsed = relative_date_parse(target_date)
        lifecycle_type = request.GET.get("lifecycle_type", None)
        if lifecycle_type is None:
            return response.Response(
                {"message": "Missing parameter", "detail": "Must include lifecycle type"}, status=400
            )

        limit = int(request.GET.get("limit", 100))
        next_url: Optional[str] = request.get_full_path()
        people = self.lifecycle_class().get_people(
            target_date=target_date_parsed,
            filter=filter,
            team=team,
            lifecycle_type=lifecycle_type,
            request=request,
            limit=limit,
        )
        next_url = paginated_result(people, request, filter.offset)
        return response.Response({"results": [{"people": people, "count": len(people)}], "next": next_url})

    @action(methods=["GET"], detail=False)
    def retention(self, request: request.Request) -> response.Response:

        display = request.GET.get("display", None)
        team = cast(User, request.user).team
        if not team:
            return response.Response(
                {"message": "Could not retrieve team", "detail": "Could not validate team associated with user"},
                status=400,
            )
        filter = RetentionFilter(request=request, team=team)
        base_uri = request.build_absolute_uri("/")

        if display == TRENDS_TABLE:
            people = self.retention_class(base_uri=base_uri).actors_in_period(filter, team)
        else:
            people = self.retention_class(base_uri=base_uri).actors(filter, team)

        next_url = paginated_result(people, request, filter.offset)

        return response.Response({"result": people, "next": next_url})

    @action(methods=["GET"], detail=False)
    def stickiness(self, request: request.Request) -> response.Response:
        team = cast(User, request.user).team
        if not team:
            return response.Response(
                {"message": "Could not retrieve team", "detail": "Could not validate team associated with user"},
                status=400,
            )
        filter = StickinessFilter(request=request, team=team, get_earliest_timestamp=get_earliest_timestamp)
        if not filter.limit:
            filter = filter.with_data({LIMIT: 100})

        target_entity = get_target_entity(filter)

        people = self.stickiness_class().people(target_entity, filter, team, request)
        next_url = paginated_result(people, request, filter.offset)
        return response.Response({"results": [{"people": people, "count": len(people)}], "next": next_url})

    @action(methods=["GET"], detail=False)
    def cohorts(self, request: request.Request) -> response.Response:
        from posthog.api.cohort import CohortSerializer

        team = cast(User, request.user).team
        if not team:
            return response.Response(
                {"message": "Could not retrieve team", "detail": "Could not validate team associated with user"},
                status=400,
            )

        person = get_pk_or_uuid(self.get_queryset(), request.GET["person_id"]).get()
        cohort_ids = get_all_cohort_ids_by_person_uuid(person.uuid, team.pk)

        cohorts = Cohort.objects.filter(pk__in=cohort_ids, deleted=False)

        return response.Response({"results": CohortSerializer(cohorts, many=True).data})

    @action(methods=["GET"], url_path="activity", detail=False)
    def all_activity(self, request: request.Request, **kwargs):
        limit = int(request.query_params.get("limit", "10"))
        page = int(request.query_params.get("page", "1"))

        activity_page = load_activity(scope="Person", team_id=self.team_id, limit=limit, page=page)
        return activity_page_response(activity_page, limit, page, request)

    @action(methods=["GET"], detail=True)
    def activity(self, request: request.Request, **kwargs):
        limit = int(request.query_params.get("limit", "10"))
        page = int(request.query_params.get("page", "1"))
        item_id = kwargs["pk"]
        if not self.get_queryset().filter(id=item_id, team_id=self.team_id).exists():
            return Response("", status=status.HTTP_404_NOT_FOUND)

        activity_page = load_activity(scope="Person", team_id=self.team_id, item_id=item_id, limit=limit, page=page)
        return activity_page_response(activity_page, limit, page, request)

    def update(self, request, *args, **kwargs):
        instance = self.get_object()
        capture_internal(
            distinct_id=instance.distinct_ids[0],
            ip=None,
            site_url=None,
            team_id=instance.team_id,
            now=datetime.now(),
            sent_at=None,
            event={
                "event": "$set",
                "properties": {"$set": request.data["properties"]},
                "distinct_id": instance.distinct_ids[0],
                "timestamp": datetime.now().isoformat(),
            },
        )

        log_activity(
            organization_id=self.organization.id,
            team_id=self.team.id,
            user=request.user,
            item_id=instance.pk,
            scope="Person",
            activity="updated",
            detail=Detail(changes=[Change(type="Person", action="changed", field="properties")]),
        )

        return Response(status=204)


def paginated_result(
    entites: Union[List[Dict[str, Any]], ReturnDict], request: request.Request, offset: int = 0,
) -> Optional[str]:
    return format_paginated_url(request, offset, 100) if len(entites) > 99 else None


class LegacyPersonViewSet(PersonViewSet):
    legacy_team_compatibility = True
