import React from 'react'
import { Alert, Form, Button, Table, Input } from 'antd'
import { licenseLogic } from './logic'
import { useValues, useActions } from 'kea'
import { humanFriendlyDetailedTime, humanFriendlyNumber } from 'lib/utils'
import { CodeSnippet } from 'scenes/ingestion/frameworks/CodeSnippet'
import { PageHeader } from 'lib/components/PageHeader'
import { InfoCircleOutlined } from '@ant-design/icons'
import { Tooltip } from 'lib/components/Tooltip'
import { SceneExport } from 'scenes/sceneTypes'
import { LicenseType } from '~/types'
import { systemStatusLogic } from '../SystemStatus/systemStatusLogic'

export const scene: SceneExport = {
    component: Licenses,
    logic: licenseLogic,
}

export function isLicenseExpired(license: LicenseType): boolean {
    return new Date(license.valid_until) < new Date()
}

const columns = [
    {
        title: 'Active',
        render: function renderActive(license: any) {
            return isLicenseExpired(license) ? 'expired' : 'active'
        },
    },
    {
        title: 'Valid until',
        render: function renderActive(license: any) {
            return humanFriendlyDetailedTime(license.valid_until)
        },
    },
    {
        title: 'Plan',
        dataIndex: 'plan',
    },
    {
        title: function Render() {
            return (
                <Tooltip
                    placement="right"
                    title="Maximum number of team members that you can have across all organizations with your current license."
                >
                    Max # of team members
                    <InfoCircleOutlined className="info-indicator" />
                </Tooltip>
            )
        },
        render: function renderMaxUsers(license: any) {
            return license.max_users === null ? 'Unlimited' : license.max_users
        },
    },
    {
        title: 'Key',
        render: function renderActive(license: any) {
            return <CodeSnippet>{license.key}</CodeSnippet>
        },
    },
    {
        title: 'License added on',
        render: function renderActive(license: any) {
            return humanFriendlyDetailedTime(license.created_at)
        },
    },
]

export function Licenses(): JSX.Element {
    const [form] = Form.useForm()
    const { licenses, licensesLoading, error } = useValues(licenseLogic)
    const { createLicense } = useActions(licenseLogic)
    const { systemStatus } = useValues(systemStatusLogic)
    const billable_events = systemStatus?.overview.filter(
        ({ key }) => key === 'clickhouse_billing_event_count_month_to_date'
    )[0].value as number

    return (
        <div>
            <PageHeader
                title="Licenses"
                caption={
                    <>
                        Here you can add and manage your PostHog enterprise licenses. When you activate a license key,
                        enterprise functionality will be enabled immediately.{' '}
                        <a href="https://posthog.com/pricing" target="_blank">
                            Click here
                        </a>{' '}
                        to grab a license key (first 1 million events free!). Contact{' '}
                        <a href="mailto:sales@posthog.com">sales@posthog.com</a> if you have any issues with a license.
                        {billable_events > -1 && licenses.length === 0 && !licensesLoading && systemStatus && (
                            <p>
                                <br />
                                When you activate a license, you'll be billed based on usage. To give you an indication,
                                you've used <strong>{humanFriendlyNumber(billable_events)}</strong> events this month.
                            </p>
                        )}
                    </>
                }
            />
            {error && (
                <Alert
                    message={
                        error.detail || <span>Could not validate license key. Please try again or contact us.</span>
                    }
                    type="error"
                    style={{ marginBottom: '1em' }}
                />
            )}
            <Form
                form={form}
                name="horizontal_login"
                layout="inline"
                onFinish={(values) => createLicense({ key: values.key })}
                style={{ marginBottom: '1rem' }}
            >
                <Form.Item name="key" rules={[{ required: true, message: 'Please input a license key!' }]}>
                    <Input placeholder="License key" style={{ minWidth: 400 }} />
                </Form.Item>
                <Form.Item shouldUpdate={true}>
                    {() => (
                        <Button
                            type="primary"
                            htmlType="submit"
                            disabled={
                                !form.isFieldsTouched(true) ||
                                !!form.getFieldsError().filter(({ errors }) => errors.length).length
                            }
                        >
                            Activate License Key
                        </Button>
                    )}
                </Form.Item>
            </Form>
            <Table
                data-attr="license-table"
                size="small"
                rowKey="id"
                pagination={false}
                rowClassName="cursor-pointer"
                dataSource={licenses}
                columns={columns}
                loading={licensesLoading}
            />
        </div>
    )
}
