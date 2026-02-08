import got from 'got';
import logger from '../utils/logger.js';

/**
 * Kick API response types
 */
interface KickChannel {
	id: string;
	username: string;
	videos: KickVideo[];
}

interface KickVideo {
	uuid: string;
	thumbnail: { src: string };
	start_time: string;
}

interface KickChannelInfo {
	id: string;
	username: string;
}

/**
 * Kick stream interface
 */
export interface KickStream {
	url: string;
	quality: string;
	resolution: string;
	width?: number;
	height?: number;
	bandwidth?: number;
	framerate?: number;
	codecs?: string;
}

/**
 * Kick API response wrapper
 */
interface KickAPIResponse {
	data?: any;
	errors?: Array<{ message: string }>;
}

/**
 * Base URLs to try for Kick streams
 */
const KICK_BASE_URLS = [
	'https://stream.kick.com/ivs/v1/196233775518',
	'https://stream.kick.com/3c81249a5ce0/ivs/v1/196233775518',
	'https://stream.kick.com/0f3cb0ebce7/ivs/v1/196233775518'
];

/**
 * Available quality options for Kick streams
 */
export const KICK_QUALITIES = ['auto', '1080p60', '720p60', '480p30', '360p30', '160p30'];

/**
 * Get Kick channel information
 */
async function getKickChannelInfo(channelName: string): Promise<KickChannelInfo> {
	try {
		const response = await got.get(`https://kick.com/api/v2/channels/${channelName}`, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
			},
			timeout: {
				request: 15000
			}
		}).json() as KickAPIResponse;

		if (response.errors) {
			throw new Error(`Kick API error: ${JSON.stringify(response.errors)}`);
		}

		if (!response.data) {
			throw new Error('No data returned from Kick API');
		}

		return {
			id: response.data.id,
			username: response.data.username
		};
	} catch (error) {
		logger.error('Failed to get Kick channel info:', error);
		throw error;
	}
}

/**
 * Get Kick channel with videos
 */
async function getKickChannelVideos(channelName: string): Promise<KickChannel> {
	try {
		const response = await got.get(`https://kick.com/api/v2/channels/${channelName}/videos`, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
			},
			timeout: {
				request: 15000
			}
		}).json() as KickAPIResponse;

		if (response.errors) {
			throw new Error(`Kick API error: ${JSON.stringify(response.errors)}`);
		}

		if (!response.data) {
			throw new Error('No data returned from Kick API');
		}

		return response.data as KickChannel;
	} catch (error) {
		logger.error('Failed to get Kick channel videos:', error);
		throw error;
	}
}

/**
 * Generate Kick stream URLs for a video
 */
async function generateKickStreamUrls(channelName: string, videoSlug: string, quality: string): Promise<string | null> {
	try {
		const channelVideos = await getKickChannelVideos(channelName);

		// Find the video by UUID
		const video = channelVideos.videos.find((v: KickVideo) => v.uuid === videoSlug);
		if (!video) {
			logger.error(`Video ${videoSlug} not found for channel ${channelName}`);
			return null;
		}

		// Parse thumbnail URL to extract channel_id and video_id
		const thumbnailUrl = video.thumbnail.src;
		const pathParts = thumbnailUrl.split('/');
		if (pathParts.length < 6) {
			logger.error('Invalid thumbnail URL format');
			return null;
		}

		const channelId = pathParts[4];
		const videoId = pathParts[5];

		// Parse start time
		const startTime = new Date(video.start_time);

		// Try all base URLs with ±5 minutes offset
		for (const offset of [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]) {
			const adjustedTime = new Date(startTime.getTime() + offset * 60 * 1000);

			const year = adjustedTime.getFullYear();
			const month = adjustedTime.getMonth() + 1; // getMonth() is 0-indexed
			const day = adjustedTime.getDate();
			const hour = adjustedTime.getHours();
			const minute = adjustedTime.getMinutes();

			for (const baseUrl of KICK_BASE_URLS) {
				const streamUrl = `${baseUrl}/${channelId}/${year}/${month}/${day}/${hour}/${minute}/${videoId}/media/hls/${quality === 'auto' ? 'master.m3u8' : `${quality}/playlist.m3u8`}`;

				logger.debug(`Trying stream URL: ${streamUrl}`);

				// Test the URL with a HEAD request
				try {
					const response = await got.head(streamUrl, {
						headers: {
							'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
						},
						timeout: {
							request: 5000
						},
						throwHttpErrors: false
					});

					if (response.statusCode === 200) {
						logger.info(`Found valid Kick stream at offset ${offset} minute(s): ${streamUrl}`);
						return streamUrl;
					}
				} catch (testError) {
					// Continue to next URL
					continue;
				}
			}
		}

		logger.error('Could not find a valid Kick stream within ±5 minutes');
		return null;
	} catch (error) {
		logger.error('Failed to generate Kick stream URLs:', error);
		return null;
	}
}

/**
 * Get live Kick stream URL for a channel
 */
export async function getKickLiveStream(channelName: string, quality: string = 'auto'): Promise<KickStream | null> {
	try {
		logger.info(`Fetching live Kick stream for channel: ${channelName}`);

		// Get channel info
		const channelInfo = await getKickChannelInfo(channelName);

		// Get channel's live stream
		const response = await got.get(`https://kick.com/api/v2/channels/${channelName}/livestream`, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
			},
			timeout: {
				request: 15000
			}
		}).json() as KickAPIResponse;

		if (response.errors) {
			throw new Error(`Kick API error: ${JSON.stringify(response.errors)}`);
		}

		if (!response.data || !response.data.livestream) {
			logger.error(`Channel ${channelName} is not currently live`);
			return null;
		}

		const livestreamData = response.data.livestream;

		// Check if we have HLS playback URL
		if (livestreamData.hls_playlist_url) {
			logger.info(`Found live Kick stream: ${livestreamData.hls_playlist_url}`);

			// If auto quality, use the master playlist
			const streamUrl = quality === 'auto' ? livestreamData.hls_playlist_url : `${livestreamData.hls_playlist_url.replace('master.m3u8', '')}${quality}/playlist.m3u8`;

			return {
				url: streamUrl,
				quality: quality,
				resolution: quality === 'auto' ? 'auto' : quality,
			};
		}

		logger.error(`No HLS playlist URL found for live stream of channel ${channelName}`);
		return null;
	} catch (error) {
		logger.error(`Failed to get live Kick stream for channel ${channelName}:`, error);
		return null;
	}
}

/**
 * Get Kick VOD stream URL
 */
export async function getKickVod(channelName: string, videoSlug: string, quality: string = 'auto'): Promise<KickStream | null> {
	try {
		logger.info(`Fetching Kick VOD: ${channelName}/${videoSlug}`);

		// Generate and test stream URLs
		const streamUrl = await generateKickStreamUrls(channelName, videoSlug, quality);

		if (streamUrl) {
			return {
				url: streamUrl,
				quality: quality,
				resolution: quality === 'auto' ? 'auto' : quality,
			};
		}

		return null;
	} catch (error) {
		logger.error(`Failed to get Kick VOD ${channelName}/${videoSlug}:`, error);
		return null;
	}
}

/**
 * Parse Kick URL to extract channel name and optional video slug
 */
export function parseKickUrl(url: string): { channelName: string; videoSlug?: string } | null {
	try {
		const urlObj = new URL(url);

		// Check if it's a kick.com URL
		if (!urlObj.hostname.includes('kick.com')) {
			return null;
		}

		const pathParts = urlObj.pathname.split('/').filter(part => part.length > 0);

		if (pathParts.length === 0) {
			return null;
		}

		// Format: kick.com/{channelName}
		// Format: kick.com/{channelName}/video/{videoSlug}
		const channelName = pathParts[0];
		let videoSlug: string | undefined;

		// Check if it's a VOD URL
		if (pathParts.length >= 3 && (pathParts[1] === 'video' || pathParts[1] === 'videos')) {
			videoSlug = pathParts[2];
		}

		return { channelName, videoSlug };
	} catch (error) {
		logger.error('Failed to parse Kick URL:', error);
		return null;
	}
}

/**
 * Get the best matching stream based on preferred quality
 */
export function getBestKickStream(streams: KickStream[], preferredQuality: string = 'auto'): KickStream | null {
	if (streams.length === 0) {
		return null;
	}

	// If no preferred quality, return the first stream
	if (preferredQuality === 'auto' || !preferredQuality) {
		return streams[0];
	}

	// Try to find exact match
	const exactMatch = streams.find(s => s.quality === preferredQuality);
	if (exactMatch) {
		return exactMatch;
	}

	// Return first stream if no match
	return streams[0];
}
