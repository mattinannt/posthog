import http from 'node:http'
import https from 'node:https'
import fetch, { RequestInfo, RequestInit, Response } from 'node-fetch'

// set keepAlive to make requests faster as we're constantly hitting the same endpoints for e.g. event exports
const httpAgent = new http.Agent({
    keepAlive: true,
})

const httpsAgent = new https.Agent({
    keepAlive: true,
})

export async function fetchExtension(url: RequestInfo, init?: RequestInit): Promise<Response> {
    init = init ?? {}
    return await fetch(url, {
        agent: (_parsedURL) => (_parsedURL.protocol == 'http:' ? httpAgent : httpsAgent),
        ...init,
    })
}
