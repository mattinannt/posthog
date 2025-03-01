import React from 'react'
import { useValues, useActions } from 'kea'
import { MINIMUM_IMPLICIT_ACCESS_LEVEL, teamMembersLogic } from './teamMembersLogic'
import { DownOutlined, CrownFilled, UpOutlined, CloseCircleOutlined, LogoutOutlined } from '@ant-design/icons'
import { humanFriendlyDetailedTime } from 'lib/utils'
import { OrganizationMembershipLevel } from 'lib/constants'
import { TeamType, UserType, FusedTeamMemberType } from '~/types'
import { userLogic } from 'scenes/userLogic'
import { ProfilePicture } from 'lib/components/ProfilePicture'
import { teamLogic } from 'scenes/teamLogic'
import {
    getReasonForAccessLevelChangeProhibition,
    membershipLevelToName,
    teamMembershipLevelIntegers,
} from '../../../lib/utils/permissioning'
import { AddMembersModalWithButton } from './AddMembersModal'
import { RestrictedArea, RestrictionScope } from '../../../lib/components/RestrictedArea'
import { LemonButton, LemonButtonWithPopup, LemonTable } from '@posthog/lemon-ui'
import { LemonTableColumns } from 'lib/components/LemonTable'
import { Tooltip } from 'lib/components/Tooltip'
import { LemonDialog } from 'lib/components/LemonDialog'

function LevelComponent(member: FusedTeamMemberType): JSX.Element | null {
    const { user } = useValues(userLogic)
    const { currentTeam } = useValues(teamLogic)
    const { changeUserAccessLevel } = useActions(teamMembersLogic)

    const myMembershipLevel = currentTeam ? currentTeam.effective_membership_level : null

    if (!user) {
        return null
    }

    const isImplicit = member.organization_level >= OrganizationMembershipLevel.Admin
    const levelName = membershipLevelToName.get(member.level) ?? `unknown (${member.level})`

    const allowedLevels = teamMembershipLevelIntegers.filter(
        (listLevel) => !getReasonForAccessLevelChangeProhibition(myMembershipLevel, user, member, listLevel)
    )

    const levelButton = (
        <LemonButtonWithPopup
            type="secondary"
            data-attr="change-membership-level"
            icon={member.level === OrganizationMembershipLevel.Owner ? <CrownFilled /> : undefined}
            // Org admins have implicit access anyway, so it doesn't make sense to edit them
            disabled={isImplicit}
            popup={{
                overlay: (
                    <>
                        {allowedLevels.map((listLevel) => (
                            <LemonButton
                                key={listLevel}
                                status="stealth"
                                fullWidth
                                onClick={() => {
                                    changeUserAccessLevel(member.user, listLevel)
                                }}
                            >
                                {listLevel > member.level ? (
                                    <>
                                        <UpOutlined style={{ marginRight: '0.5rem' }} />
                                        Upgrade to project {membershipLevelToName.get(listLevel)}
                                    </>
                                ) : (
                                    <>
                                        <DownOutlined style={{ marginRight: '0.5rem' }} />
                                        Downgrade to project {membershipLevelToName.get(listLevel)}
                                    </>
                                )}
                            </LemonButton>
                        ))}
                    </>
                ),
            }}
        >
            {levelName}
        </LemonButtonWithPopup>
    )

    const disallowedReason = isImplicit
        ? `This user is a member of the project implicitly due to being an organization ${levelName}.`
        : getReasonForAccessLevelChangeProhibition(myMembershipLevel, user, member, allowedLevels)

    return disallowedReason ? <Tooltip title={disallowedReason}>{levelButton}</Tooltip> : levelButton
}

function ActionsComponent(member: FusedTeamMemberType): JSX.Element | null {
    const { user } = useValues(userLogic)
    const { currentTeam } = useValues(teamLogic)
    const { removeMember } = useActions(teamMembersLogic)

    if (!user) {
        return null
    }

    function handleClick(): void {
        LemonDialog.open({
            title: `${
                member.user.uuid == user?.uuid
                    ? 'Leave'
                    : `Remove ${member.user.first_name} (${member.user.email}) from`
            } project ${currentTeam?.name}?`,
            secondaryButton: {
                children: 'Cancel',
            },
            primaryButton: {
                status: 'danger',
                children: member.user.uuid == user?.uuid ? 'Leave' : 'Remove',
                onClick: () => removeMember({ member }),
            },
        })
    }

    const allowDeletion =
        // You can leave, but only project admins can remove others
        ((currentTeam?.effective_membership_level &&
            currentTeam.effective_membership_level >= OrganizationMembershipLevel.Admin) ||
            member.user.uuid === user.uuid) &&
        // Only members without implicit access can leave or be removed
        member.organization_level < MINIMUM_IMPLICIT_ACCESS_LEVEL

    return allowDeletion ? (
        <LemonButton status="danger" onClick={handleClick} data-attr="delete-team-membership">
            {member.user.uuid !== user.uuid ? (
                <CloseCircleOutlined title="Remove from project" />
            ) : (
                <LogoutOutlined title="Leave project" />
            )}
        </LemonButton>
    ) : null
}

export interface MembersProps {
    user: UserType
    team: TeamType
}

export function TeamMembers({ user }: MembersProps): JSX.Element {
    const { allMembers, allMembersLoading } = useValues(teamMembersLogic)

    const columns: LemonTableColumns<FusedTeamMemberType> = [
        {
            key: 'user_profile_picture',
            render: function ProfilePictureRender(_, member) {
                return <ProfilePicture name={member.user.first_name} email={member.user.email} />
            },
            width: 32,
        },
        {
            title: 'Name',
            key: 'user_first_name',
            render: (_, member) =>
                member.user.uuid == user.uuid ? `${member.user.first_name} (me)` : member.user.first_name,
            sorter: (a, b) => a.user.first_name.localeCompare(b.user.first_name),
        },
        {
            title: 'Email',
            key: 'user_email',
            render: (_, member) => member.user.email,
            sorter: (a, b) => a.user.email.localeCompare(b.user.email),
        },
        {
            title: 'Level',
            key: 'level',
            render: function LevelRender(_, member) {
                return LevelComponent(member)
            },
            sorter: (a, b) => a.level - b.level,
        },
        {
            title: 'Joined At',
            dataIndex: 'joined_at',
            key: 'joined_at',
            render: (_, member) => humanFriendlyDetailedTime(member.joined_at),
            sorter: (a, b) => a.joined_at.localeCompare(b.joined_at),
        },
        {
            key: 'actions',
            align: 'center',
            render: function ActionsRender(_, member) {
                return ActionsComponent(member)
            },
        },
    ]

    return (
        <>
            <h2 className="subtitle flex justify-between items-center" id="members-with-project-access">
                Members with Project Access
                <RestrictedArea
                    Component={AddMembersModalWithButton}
                    minimumAccessLevel={OrganizationMembershipLevel.Admin}
                    scope={RestrictionScope.Project}
                />
            </h2>

            <LemonTable
                columns={columns}
                dataSource={allMembers}
                loading={allMembersLoading}
                data-attr="team-members-table"
            />
        </>
    )
}
