import { PreIngestionEvent } from '../../../../src/types'
import { createEventStep } from '../../../../src/worker/ingestion/event-pipeline/5-createEventStep'
import { LazyPersonContainer } from '../../../../src/worker/ingestion/lazy-person-container'

jest.mock('../../../../src/worker/plugins/run')

const preIngestionEvent: PreIngestionEvent = {
    eventUuid: 'uuid1',
    distinctId: 'my_id',
    ip: '127.0.0.1',
    teamId: 2,
    timestamp: '2020-02-23T02:15:00.000Z',
    event: '$pageview',
    properties: {},
    elementsList: [],
}

describe('createEventStep()', () => {
    let runner: any

    beforeEach(() => {
        runner = {
            nextStep: (...args: any[]) => args,
            hub: {
                eventsProcessor: {
                    createEvent: jest.fn().mockReturnValue(preIngestionEvent),
                },
            },
        }
    })

    it('calls `createEvent` and forwards to `runAsyncHandlersStep`', async () => {
        const personContainer = new LazyPersonContainer(2, 'my_id', runner.hub)
        const response = await createEventStep(runner, preIngestionEvent, personContainer)

        expect(response).toEqual(['runAsyncHandlersStep', preIngestionEvent, personContainer])
    })
})
