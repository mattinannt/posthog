import { LemonCheckbox, LemonInput } from '@posthog/lemon-ui'
import { LemonTag } from 'lib/components/LemonTag/LemonTag'
import React from 'react'
import { MetricValue } from './RenderMetricValue'

interface MetricValueEditInterface extends MetricValue {
    onValueChanged: (key: string, value: any) => void
}

export function RenderMetricValueEdit({
    key,
    value,
    value_type,
    onValueChanged,
    isSecret,
}: MetricValueEditInterface): JSX.Element | string {
    if (value_type === 'bool') {
        return (
            <LemonCheckbox
                defaultChecked={!!value}
                onChange={(e) => onValueChanged(key, e.target.checked)}
                label={<LemonTag type={value ? 'success' : 'danger'}>{value ? 'Yes' : 'No'}</LemonTag>}
            />
        )
    }

    const parsedValue = isSecret && value ? '' : (value as string | number)

    return (
        <LemonInput
            defaultValue={parsedValue as any}
            type={value_type === 'int' ? 'number' : 'text'}
            placeholder={isSecret && value ? 'Keep existing secret value' : undefined}
            onBlur={(e) => onValueChanged(key, e.target.value)}
        />
    )
}
