import { kea } from 'kea'
import api from 'lib/api'
import type { billingLogicType } from './billingLogicType'
import { PlanInterface, BillingType } from '~/types'
import { preflightLogic } from 'scenes/PreflightCheck/preflightLogic'
import posthog from 'posthog-js'
import { sceneLogic } from 'scenes/sceneLogic'
import { Scene } from 'scenes/sceneTypes'
import { lemonToast } from 'lib/components/lemonToast'
import { router } from 'kea-router'
import { featureFlagLogic } from 'lib/logic/featureFlagLogic'
import { FEATURE_FLAGS } from 'lib/constants'

export const UTM_TAGS = 'utm_medium=in-product&utm_campaign=billing-management'
export const ALLOCATION_THRESHOLD_ALERT = 0.85 // Threshold to show warning of event usage near limit
export const FREE_PLAN_MAX_EVENTS = 1000000
export const FREE_PLAN_EVENTS_THRESHOLD = 0.85

export enum BillingAlertType {
    SetupBilling = 'setup_billing',
    UsageNearLimit = 'usage_near_limit',
    UsageLimitExceeded = 'usage_limit_exceeded',
    FreeUsageNearLimit = 'free_usage_near_limit',
}

export const billingLogic = kea<billingLogicType>({
    path: ['scenes', 'billing', 'billingLogic'],
    actions: {
        registerInstrumentationProps: true,
    },
    connect: {
        values: [featureFlagLogic, ['featureFlags']],
    },
    loaders: ({ actions, values }) => ({
        billing: [
            null as BillingType | null,
            {
                loadBilling: async () => {
                    const response = await api.get('api/billing/')
                    if (!response?.plan) {
                        actions.loadPlans()
                    }
                    if (
                        response.current_usage > FREE_PLAN_MAX_EVENTS &&
                        response.should_setup_billing &&
                        router.values.location.pathname !== '/organization/billing/locked' &&
                        values.featureFlags[FEATURE_FLAGS.BILLING_LOCK_EVERYTHING]
                    ) {
                        posthog.capture('billing locked screen shown')
                        router.actions.replace('/organization/billing/locked')
                    }
                    actions.registerInstrumentationProps()
                    return response as BillingType
                },
                setBillingLimit: async (billing: BillingType) => {
                    const res = await api.update('api/billing/', billing)
                    lemonToast.success(`Billing limit set to $${billing.billing_limit} usd/month`)

                    return res as BillingType
                },
            },
        ],
        plans: [
            [] as PlanInterface[],
            {
                loadPlans: async () => {
                    const response = await api.get('api/plans?self_serve=1')
                    return response.results
                },
            },
        ],
        billingSubscription: [
            null as BillingType | null,
            {
                subscribe: async (plan) => {
                    return await api.create('billing/subscribe', { plan })
                },
            },
        ],
    }),
    selectors: {
        eventAllocation: [(s) => [s.billing], (billing: BillingType) => billing?.event_allocation],
        percentage: [
            (s) => [s.eventAllocation, s.billing],
            (eventAllocation: number | null, billing: BillingType) => {
                if (!eventAllocation || !billing?.current_usage) {
                    return null
                }
                return Math.min(Math.round((billing.current_usage / eventAllocation) * 100) / 100, 1)
            },
        ],
        freePlanPercentage: [
            (s) => [s.billing],
            (billing: BillingType) => {
                if (!billing?.current_usage) {
                    return null
                }
                return Math.min(Math.round((billing.current_usage / FREE_PLAN_MAX_EVENTS) * 100) / 100, 1)
            },
        ],
        strokeColor: [
            (selectors) => [selectors.percentage],
            (percentage) => {
                let color: string | Record<string, string> = 'var(--primary)'
                if (percentage === null || percentage === undefined) {
                    /* No event limit set */
                    color = {
                        from: '#1890FF',
                        to: '#52C41A',
                    }
                }

                if (percentage && percentage > 0.65 && percentage < 0.8) {
                    color = 'var(--warning)'
                }
                if (percentage && percentage > 0.8) {
                    color = 'var(--danger)'
                }
                return color
            },
        ],
        alertToShow: [
            (s) => [s.eventAllocation, s.percentage, s.freePlanPercentage, s.billing, sceneLogic.selectors.scene],
            (
                eventAllocation: number | null,
                percentage: number,
                freePlanPercentage: number,
                billing: BillingType,
                scene: Scene
            ): BillingAlertType | undefined => {
                // Determines which billing alert/warning to show to the user (if any)

                // Priority 1: In-progress incomplete billing setup
                if (billing?.should_setup_billing && billing?.subscription_url) {
                    return BillingAlertType.SetupBilling
                }

                // Priority 2: Event allowance exceeded or near limit
                if (billing?.billing_limit_exceeded) {
                    return BillingAlertType.UsageLimitExceeded
                }

                // Priority 3: Event allowance near threshold
                if (
                    scene !== Scene.Billing &&
                    billing?.current_usage &&
                    eventAllocation &&
                    percentage >= ALLOCATION_THRESHOLD_ALERT
                ) {
                    return BillingAlertType.UsageNearLimit
                }

                // Priority 4: Users on free account that are almost reaching free events threshold
                if (
                    !billing?.is_billing_active &&
                    billing?.current_usage &&
                    freePlanPercentage > FREE_PLAN_EVENTS_THRESHOLD
                ) {
                    return BillingAlertType.FreeUsageNearLimit
                }
            },
        ],
    },
    events: ({ actions }) => ({
        afterMount: () => {
            if (preflightLogic.values.preflight?.cloud) {
                actions.loadBilling()
            }
        },
    }),
    listeners: ({ values }) => ({
        subscribeSuccess: ({ billingSubscription }) => {
            if (billingSubscription?.subscription_url) {
                window.location.href = billingSubscription.subscription_url
            }
        },
        registerInstrumentationProps: async (_, breakpoint) => {
            await breakpoint(100)
            if (posthog && values.billing) {
                posthog.register({
                    has_billing_plan: !!values.billing?.plan,
                    metered_billing: values.billing.plan?.is_metered_billing,
                    event_allocation: values.billing.event_allocation,
                    allocation_used:
                        values.billing.event_allocation && values.billing.current_usage !== null
                            ? values.billing.current_usage / values.billing.event_allocation
                            : undefined,
                })
            }
        },
    }),
})
