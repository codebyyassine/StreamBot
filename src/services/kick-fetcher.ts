import logger from '../utils/logger.js';
import { executePythonScript } from '../utils/python-script.js';

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
	available_qualities?: string[];
}

/**
 * Available quality options for Kick streams
 */
export const KICK_QUALITIES = ['auto', '1080p60', '720p60', '480p30', '360p30', '160p30'];

/**
 * Interface for Python script response (updated to include available_qualities)
 */
interface PythonKickResponse {
	success: boolean;
	url: string | null;
	quality: string;
	available_qualities: string[];
	error?: string;
}

/**
 * Get live Kick stream URL for a channel using Python script
 */
export async function getKickLiveStream(channelName: string, quality: string = 'auto'): Promise<KickStream | null> {
	try {
		const kickUrl = `https://kick.com/${channelName}`;
		logger.info(`Fetching live Kick stream for channel: ${channelName} via Python script`);

		const { stdout } = await executePythonScript('kick-fetch.py', [kickUrl, quality], 30000);
		const result: PythonKickResponse = JSON.parse(stdout);

		if (result.success && result.url) {
			logger.info(`Found Kick stream via Python: ${result.url}`);
			return {
				url: result.url,
				quality: result.quality,
				resolution: result.quality === 'auto' ? 'auto' : result.quality,
			};
		}

		if (result.error) {
			logger.error(`Python script error: ${result.error}`);
		}

		return null;
	} catch (error: any) {
		logger.error(`Failed to get live Kick stream via Python:`, error);

		// If the error is about missing cloudscraper, provide helpful message
		if (error.stderr && 'cloudscraper' in error.stderr) {
			logger.error('cloudscraper is not installed. Run: pip install -r src/scripts/requirements.txt');
		}

		return null;
	}
}

/**
 * Get Kick VOD stream URL using Python script
 */
export async function getKickVod(channelName: string, videoSlug: string, quality: string = 'auto'): Promise<KickStream | null> {
	try {
		const kickUrl = `https://kick.com/${channelName}/video/${videoSlug}`;
		logger.info(`Fetching Kick VOD: ${channelName}/${videoSlug} via Python script`);

		const { stdout } = await executePythonScript('kick-fetch.py', [kickUrl, quality], 30000);
		const result: PythonKickResponse = JSON.parse(stdout);

		if (result.success && result.url) {
			logger.info(`Found Kick VOD stream via Python: ${result.url}`);
			return {
				url: result.url,
				quality: result.quality,
				resolution: result.quality === 'auto' ? 'auto' : result.quality,
			};
		}

		if (result.error) {
			logger.error(`Python script error: ${result.error}`);
		}

		return null;
	} catch (error: any) {
		logger.error(`Failed to get Kick VOD via Python:`, error);

		// If the error is about missing cloudscraper, provide helpful message
		if (error.stderr && 'cloudscraper' in error.stderr) {
			logger.error('cloudscraper is not installed. Run: pip install -r src/scripts/requirements.txt');
		}

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
