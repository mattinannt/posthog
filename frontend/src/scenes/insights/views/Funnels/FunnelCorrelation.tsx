import { Card } from 'antd'
import { CommentOutlined } from '@ant-design/icons'
import { useActions, useValues } from 'kea'
import React, { useRef } from 'react'
import { funnelLogic } from 'scenes/funnels/funnelLogic'
import './FunnelCorrelation.scss'
import { IconClose, IconFeedbackWarning } from 'lib/components/icons'
import { CloseOutlined } from '@ant-design/icons'
import { PayCard } from 'lib/components/PayCard/PayCard'
import { AvailableFeature } from '~/types'
import { preflightLogic } from 'scenes/PreflightCheck/preflightLogic'
import { insightLogic } from 'scenes/insights/insightLogic'
import { FunnelCorrelationTable } from './FunnelCorrelationTable'
import { FunnelPropertyCorrelationTable } from './FunnelPropertyCorrelationTable'
import { LemonButton, LemonTextArea } from '@posthog/lemon-ui'

export const FunnelCorrelation = (): JSX.Element | null => {
    const { insightProps } = useValues(insightLogic)
    const {
        isSkewed,
        stepsWithCount,
        correlationFeedbackHidden,
        correlationDetailedFeedbackVisible,
        correlationFeedbackRating,
        correlationAnalysisAvailable,
        aggregationTargetLabel,
    } = useValues(funnelLogic(insightProps))
    const {
        sendCorrelationAnalysisFeedback,
        hideSkewWarning,
        hideCorrelationAnalysisFeedback,
        setCorrelationFeedbackRating,
        setCorrelationDetailedFeedback,
    } = useActions(funnelLogic(insightProps))
    const { preflight } = useValues(preflightLogic)

    const detailedFeedbackRef = useRef<HTMLTextAreaElement>(null)

    if (stepsWithCount.length <= 1) {
        return null
    }

    if (!correlationAnalysisAvailable && !preflight?.instance_preferences?.disable_paid_fs) {
        return (
            <PayCard
                identifier={AvailableFeature.CORRELATION_ANALYSIS}
                title={`Get a deeper understanding of why your ${aggregationTargetLabel.plural} are not converting`}
                caption={`Correlation analysis automatically finds signals for why ${aggregationTargetLabel.plural} are converting or dropping off.`}
            />
        )
    }

    return (
        <>
            <h2 style={{ margin: '1rem 0' }}>Correlation analysis</h2>
            <div className="funnel-correlation">
                {isSkewed && (
                    <Card className="skew-warning">
                        <h4>
                            <IconFeedbackWarning style={{ fontSize: 24, marginRight: 4, color: 'var(--warning)' }} />{' '}
                            Adjust your funnel definition to improve correlation analysis
                            <CloseOutlined className="close-button" onClick={hideSkewWarning} />
                        </h4>
                        <div>
                            <b>Tips for adjusting your funnel:</b>
                            <ol>
                                <li>
                                    Adjust your first funnel step to be more specific. For example, choose a page or an
                                    event that occurs less frequently.
                                </li>
                                <li>Choose an event that happens more frequently for subsequent funnels steps.</li>
                            </ol>
                        </div>
                    </Card>
                )}

                <FunnelCorrelationTable />

                {/* Feedback Form */}
                {!correlationFeedbackHidden && (
                    <div className="border rounded p-4 space-y-2 mt-4">
                        <div className="flex items-center justify-between">
                            <h4 className="text-muted-alt">
                                <CommentOutlined style={{ marginRight: 4 }} />
                                Was this correlation analysis report useful?
                            </h4>
                            <div className="flex items-center gap-2">
                                {!!correlationFeedbackRating && (
                                    <i className="text-success mr-2">Thanks for your feedback!</i>
                                )}
                                {(
                                    [
                                        [5, '😍'],
                                        [4, '😀'],
                                        [3, '😴'],
                                        [2, '😔'],
                                        [1, '👎'],
                                    ] as const
                                ).map((content, index) => (
                                    <LemonButton
                                        key={index}
                                        active={correlationFeedbackRating === content[0]}
                                        onClick={() => {
                                            if (correlationFeedbackRating === content[0]) {
                                                setCorrelationFeedbackRating(0)
                                            } else {
                                                setCorrelationFeedbackRating(content[0])
                                                setTimeout(() => detailedFeedbackRef.current?.focus(), 100)
                                            }
                                        }}
                                    >
                                        {content[1]}
                                    </LemonButton>
                                ))}
                                <LemonButton
                                    icon={<IconClose />}
                                    onClick={hideCorrelationAnalysisFeedback}
                                    status="stealth"
                                />
                            </div>
                        </div>
                        {correlationDetailedFeedbackVisible || true ? (
                            <>
                                <form onSubmit={sendCorrelationAnalysisFeedback} className="space-y-2">
                                    <LemonTextArea
                                        onBlur={(e) => setCorrelationDetailedFeedback(e.target.value)}
                                        placeholder="Optional. Help us by sharing details around your experience..."
                                        ref={detailedFeedbackRef}
                                        onPressEnter={() => {
                                            detailedFeedbackRef.current?.blur()
                                            sendCorrelationAnalysisFeedback()
                                        }}
                                    />
                                    <div className="flex justify-end">
                                        <LemonButton
                                            data-attr="correlation-analysis-share-feedback"
                                            type="primary"
                                            htmlType="submit"
                                        >
                                            Share feedback
                                        </LemonButton>
                                    </div>
                                </form>
                            </>
                        ) : null}
                    </div>
                )}

                <FunnelPropertyCorrelationTable />
            </div>
        </>
    )
}
