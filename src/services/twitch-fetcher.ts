import { gotWithProxy, isProxyEnabled, shouldProxyStream, gotForStreaming } from './proxy.js';
import got from 'got';
import config from '../config.js';
import logger from '../utils/logger.js';
import { TwitchStream } from '../types/index.js';

/**
 * GraphQL response interface
 */
interface GraphQLResponse {
	data?: any;
	errors?: Array<{ message: string }>;
}

/**
 * Parse M3U8 playlist to extract stream URLs
 */
function parseM3U8(content: string): TwitchStream[] {
	const streams: TwitchStream[] = [];
	const lines = content.split('\n');

	let currentStream: Record<string, any> | null = null;

	for (const line of lines) {
		const trimmedLine = line.trim();

		// Skip empty lines and comments
		if (!trimmedLine || trimmedLine.startsWith('#EXT')) {
			// Parse stream info from EXT-X-STREAM-INF
			if (trimmedLine.startsWith('#EXT-X-STREAM-INF:')) {
				currentStream = {};

				// Extract resolution
				const resolutionMatch = trimmedLine.match(/RESOLUTION=(\d+)x(\d+)/);
				if (resolutionMatch) {
					currentStream.width = parseInt(resolutionMatch[1]);
					currentStream.height = parseInt(resolutionMatch[2]);
					currentStream.resolution = `${resolutionMatch[1]}x${resolutionMatch[2]}`;
				}

				// Extract bandwidth
				const bandwidthMatch = trimmedLine.match(/BANDWIDTH=(\d+)/);
				if (bandwidthMatch) {
					currentStream.bandwidth = parseInt(bandwidthMatch[1]);
				}

				// Extract frame rate
				const framerateMatch = trimmedLine.match(/FRAME-RATE=([\d.]+)/);
				if (framerateMatch) {
					currentStream.framerate = parseFloat(framerateMatch[1]);
				}

				// Extract codecs
				const codecsMatch = trimmedLine.match(/CODECS="([^"]+)"/);
				if (codecsMatch) {
					currentStream.codecs = codecsMatch[1];
				}
			}
			continue;
		}

		// This is a URL line
		if (trimmedLine && !trimmedLine.startsWith('#')) {
			if (currentStream) {
				currentStream.url = trimmedLine;
				streams.push(currentStream as TwitchStream);
				currentStream = null;
			}
		}
	}

	return streams;
}

/**
 * Get Twitch channel access token
 */
async function getAccessToken(channelId: string, isVod: boolean = false): Promise<any> {
	const query = isVod
		? `
			{
				videoPlaybackAccessToken(
					videoID: "${channelId}",
					params: {
						platform: "web",
						playerBackend: "mediaplayer",
						playerType: "site"
					}
				) {
					signature
					value
				}
			}
		`
		: `
			{
				streamPlaybackAccessToken(
					channelName: "${channelId}",
					params: {
						platform: "web",
						playerBackend: "mediaplayer",
						playerType: "site"
					}
				) {
					signature
					value
				}
			}
		`;

	try {
		const response = await gotWithProxy.post('https://gql.twitch.tv/gql', {
			json: { query },
			headers: {
				'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko'
			}
		}).json() as GraphQLResponse;

		if (response.errors) {
			throw new Error(`GraphQL error: ${JSON.stringify(response.errors)}`);
		}

		const dataKey = isVod ? 'videoPlaybackAccessToken' : 'streamPlaybackAccessToken';
		return response.data[dataKey];
	} catch (error) {
		logger.error('Failed to get access token:', error);
		throw error;
	}
}

/**
 * Get stream playlist URL for a live channel
 */
async function getLiveStreamPlaylist(channelId: string): Promise<string> {
	const accessToken = await getAccessToken(channelId, false);

	const playlistUrl = new URL(`https://usher.ttvnw.net/api/channel/hls/${channelId}.m3u8`);
	playlistUrl.searchParams.set('allow_source', 'true');
	playlistUrl.searchParams.set('allow_audio_only', 'true');
	playlistUrl.searchParams.set('sig', accessToken.signature);
	playlistUrl.searchParams.set('token', accessToken.value);
	playlistUrl.searchParams.set('player', 'twitchweb');
	playlistUrl.searchParams.set('p', Math.floor(Math.random() * 999999).toString());

	return playlistUrl.toString();
}

/**
 * Get VOD playlist URL
 */
async function getVodPlaylist(vodId: string): Promise<string> {
	const accessToken = await getAccessToken(vodId, true);

	const playlistUrl = new URL(`https://usher.ttvnw.net/vod/${vodId}.m3u8`);
	playlistUrl.searchParams.set('allow_source', 'true');
	playlistUrl.searchParams.set('allow_audio_only', 'true');
	playlistUrl.searchParams.set('sig', accessToken.signature);
	playlistUrl.searchParams.set('token', accessToken.value);
	playlistUrl.searchParams.set('player', 'twitchweb');
	playlistUrl.searchParams.set('p', Math.floor(Math.random() * 999999).toString());

	return playlistUrl.toString();
}

/**
 * Fetch M3U8 playlist and parse it
 */
async function fetchAndParsePlaylist(playlistUrl: string): Promise<TwitchStream[]> {
	try {
		// Use gotForStreaming if proxy stream is enabled, otherwise use gotWithProxy
		const gotClient = shouldProxyStream() ? gotForStreaming : gotWithProxy;
		const proxyMode = shouldProxyStream() ? ' (with stream proxy)' : '';

		logger.debug(`Fetching playlist${proxyMode}: ${playlistUrl}`);

		const response = await gotClient.get(playlistUrl, {
			headers: {
				'Accept': 'application/x-mpegURL, application/vnd.apple.mpegurl, application/json, text/plain, */*'
			}
		});

		const content = response.body as string;
		return parseM3U8(content);
	} catch (error: any) {
		// Check if this is a proxy-related error
		const isProxyError = error.code === 'EPROTO' ||
		                   error.message?.includes('proxy') ||
		                   error.message?.includes('ECONNREFUSED') ||
		                   error.message?.includes('ETIMEDOUT');

		if (isProxyError && isProxyEnabled()) {
			logger.warn('Proxy failed for playlist, falling back to direct connection:', error.message);
			logger.warn('You can disable proxy by setting TWITCH_ADBLOCK_ENABLED=false');

			// Try again without proxy
			try {
				const directResponse = await got.get(playlistUrl, {
					headers: {
						'Accept': 'application/x-mpegURL, application/vnd.apple.mpegurl, application/json, text/plain, */*'
					},
					timeout: {
						request: 30000
					}
				});

				const content = directResponse.body as string;
				return parseM3U8(content);
			} catch (directError) {
				logger.error(`Direct connection also failed for ${playlistUrl}:`, directError);
				throw directError;
			}
		}

		logger.error(`Failed to fetch playlist from ${playlistUrl}:`, error);
		throw error;
	}
}

/**
 * Get available streams for a live Twitch channel
 */
export async function getStream(channelId: string): Promise<TwitchStream[]> {
	try {
		logger.info(`Fetching stream for channel: ${channelId}`);

		// Get the master playlist URL
		const playlistUrl = await getLiveStreamPlaylist(channelId);

		// Fetch and parse the playlist
		const streams = await fetchAndParsePlaylist(playlistUrl);

		logger.info(`Found ${streams.length} streams for channel ${channelId}`);

		return streams;
	} catch (error) {
		logger.error(`Failed to get stream for channel ${channelId}:`, error);
		throw error;
	}
}

/**
 * Get available streams for a Twitch VOD
 */
export async function getVod(vodId: string): Promise<TwitchStream[]> {
	try {
		logger.info(`Fetching VOD: ${vodId}`);

		// Get the VOD playlist URL
		const playlistUrl = await getVodPlaylist(vodId);

		// Fetch and parse the playlist
		const streams = await fetchAndParsePlaylist(playlistUrl);

		logger.info(`Found ${streams.length} streams for VOD ${vodId}`);

		return streams;
	} catch (error) {
		logger.error(`Failed to get VOD ${vodId}:`, error);
		throw error;
	}
}

/**
 * Get the best matching stream based on preferred resolution
 */
export function getBestStream(streams: TwitchStream[], preferredResolution?: string): TwitchStream | null {
	if (streams.length === 0) {
		return null;
	}

	// If no preferred resolution, return the first stream
	if (!preferredResolution) {
		return streams[0];
	}

	// Try to find exact match
	const exactMatch = streams.find(s => s.resolution === preferredResolution);
	if (exactMatch) {
		return exactMatch;
	}

	// Try to find the closest resolution
	const [prefWidth, prefHeight] = preferredResolution.split('x').map(Number);
	if (isNaN(prefWidth) || isNaN(prefHeight)) {
		return streams[0];
	}

	// Find stream with closest height
	const sortedStreams = [...streams].sort((a, b) => {
		const aHeight = a.height || 0;
		const bHeight = b.height || 0;
		return Math.abs(aHeight - prefHeight) - Math.abs(bHeight - prefHeight);
	});

	return sortedStreams[0];
}
