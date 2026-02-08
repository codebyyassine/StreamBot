import { HttpsProxyAgent } from 'https-proxy-agent';
import got from 'got';
import config from '../config.js';
import logger from '../utils/logger.js';

/**
 * Domains that should be proxied to bypass Twitch ads
 * Based on TTV LOL PRO's approach
 */
const PROXY_DOMAINS = [
	'usher.ttvnw.net',
	'gql.twitch.tv',
	'video-weaver.hls.ttvnw.net',
	'playlist.live-video.net',
	'playlist.ttvnw.net',
	'passport.twitch.tv',
	'www.twitch.tv'
];

/**
 * Check if a URL should be proxied
 */
function shouldProxyUrl(url: string): boolean {
	try {
		const urlObj = new URL(url);
		const hostname = urlObj.hostname;

		// Check if hostname matches any proxy domain
		return PROXY_DOMAINS.some(domain => {
			// Exact match
			if (hostname === domain) return true;
			// Wildcard match (e.g., video-weaver.hls.ttvnw.net)
			if (hostname.endsWith(domain)) return true;
			return false;
		});
	} catch (error) {
		logger.debug('Error parsing URL for proxy check:', error);
		return false;
	}
}

/**
 * Create a proxy agent if enabled
 */
function createProxyAgent(): HttpsProxyAgent<string> | undefined {
	if (!config.twitchAdblockEnabled) {
		return undefined;
	}

	try {
		const proxyUrl = `${config.twitchAdblockProxyProtocol}://${config.twitchAdblockProxyHost}:${config.twitchAdblockProxyPort}`;
		logger.info(`Using Twitch adblock proxy: ${proxyUrl}`);
		return new HttpsProxyAgent<string>(proxyUrl);
	} catch (error) {
		logger.error('Failed to create proxy agent:', error);
		return undefined;
	}
}

const proxyAgent = createProxyAgent();

/**
 * Create a got instance with optional proxy support
 * Only proxies requests to specific Twitch domains (unless proxyStream is enabled)
 */
export function createGotInstance(forceProxy: boolean = false) {
	return got.extend({
		agent: {
			http: proxyAgent,
			https: proxyAgent
		},
		hooks: {
			beforeRequest: [
				(options) => {
					const url = options.url?.toString() || '';
					const shouldProxy = shouldProxyUrl(url) || forceProxy;

					if (shouldProxy && proxyAgent) {
						logger.debug(`Proxying request to: ${url}`);
					} else if (!proxyAgent) {
						logger.debug(`Direct connection (proxy disabled): ${url}`);
					} else {
						logger.debug(`Direct connection (not a proxy domain): ${url}`);
						// Don't use proxy for non-Twitch domains
						options.agent = undefined;
					}
				}
			],
			beforeError: [
				(error) => {
					if (proxyAgent && error.response) {
						logger.warn(`Request failed with proxy, will retry: ${error.request?.requestUrl}`);
						// Let got handle retries
					}
					return error;
				}
			]
		},
		retry: {
			limit: 3,
			methods: ['GET'],
			statusCodes: [408, 413, 429, 500, 502, 503, 504]
		},
		timeout: {
			request: 30000
		},
		headers: {
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
		}
	});
}

/**
 * Export a pre-configured got instance for API requests only
 */
export const gotWithProxy = createGotInstance(false);

/**
 * Export a pre-configured got instance for streaming (with optional proxy)
 */
export const gotForStreaming = createGotInstance(config.twitchAdblockProxyStream);

/**
 * Check if proxy is enabled
 */
export function isProxyEnabled(): boolean {
	return config.twitchAdblockEnabled && !!proxyAgent;
}

/**
 * Check if stream should be proxied
 */
export function shouldProxyStream(): boolean {
	return config.twitchAdblockEnabled && config.twitchAdblockProxyStream && !!proxyAgent;
}
