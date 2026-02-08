#!/usr/bin/env python3
"""
Kick stream fetcher using cloudscraper to bypass Cloudflare protection.
Adapted from KickNoSub to be used as an external CLI tool.
"""

import sys
import json
import urllib.parse

try:
    from cloudscraper import create_scraper
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "cloudscraper is not installed. Run: pip install cloudscraper"
    }))
    sys.exit(1)

# Enable debug mode with --debug flag
DEBUG = '--debug' in sys.argv


def log_debug(message):
    """Print debug message if debug mode is enabled."""
    if DEBUG:
        print(f"[DEBUG] {message}", file=sys.stderr)


def get_live_stream_url(channel_name: str, quality: str = "auto") -> str | None:
    """
    Get the HLS stream URL for a live Kick channel.

    Args:
        channel_name: The Kick channel name
        quality: The quality preference (auto, 1080p60, 720p60, etc.)

    Returns:
        The HLS stream URL or None if not found
    """
    try:
        # Create cloudscraper session with proper browser settings
        scraper = create_scraper(
            browser={
                'browser': 'chrome',
                'platform': 'windows',
                'desktop': True
            }
        )

        # Add headers to mimic a real browser
        scraper.headers.update({
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': f'https://kick.com/{channel_name}',
            'Origin': 'https://kick.com'
        })

        # Try to get livestream data from API
        api_url = f"https://kick.com/api/v2/channels/{channel_name}/livestream"
        log_debug(f"Fetching livestream API: {api_url}")

        response = scraper.get(api_url, timeout=15)
        log_debug(f"Response status: {response.status_code}")

        if response.status_code != 200:
            log_debug(f"Failed to get livestream from API, trying channel info...")
            # Try alternative approach - get channel info first
            channel_url = f"https://kick.com/api/v2/channels/{channel_name}"
            log_debug(f"Fetching channel info: {channel_url}")
            channel_response = scraper.get(channel_url, timeout=15)

            if channel_response.status_code == 200:
                channel_data = channel_response.json()
                log_debug(f"Channel data: {json.dumps(channel_data, indent=2)}")
                if channel_data and 'data' in channel_data:
                    livestream = channel_data['data'].get('livestream')
                    if livestream:
                        # Check for playback_url or hls_playlist_url
                        hls_url = livestream.get('playback_url') or livestream.get('hls_playlist_url')
                        if hls_url:
                            log_debug(f"Found HLS URL: {hls_url}")
                            return hls_url
            return None

        data = response.json()
        log_debug(f"Livestream response: {json.dumps(data, indent=2)}")

        if not data or 'data' not in data:
            log_debug("No data in response")
            return None

        # Check both structures:
        # 1. New structure: data.playback_url (direct under data)
        # 2. Old structure: data.livestream.hls_playlist_url
        livestream = data['data']

        # Try playback_url first (new API structure)
        hls_url = livestream.get('playback_url')
        if not hls_url:
            # Try the nested livestream structure (old API structure)
            nested_livestream = data['data'].get('livestream')
            if nested_livestream:
                hls_url = nested_livestream.get('playback_url') or nested_livestream.get('hls_playlist_url')

        if not hls_url:
            log_debug("No HLS playlist URL found in livestream data")
            return None

        log_debug(f"Found HLS URL: {hls_url}")

        # Adjust for quality if needed
        if quality != 'auto' and '.m3u8' in hls_url:
            # For quality selection, we'd need to parse the master playlist
            # For now, return the main URL
            log_debug(f"Quality selection not implemented, returning main URL")
            return hls_url

        return hls_url

    except Exception as e:
        log_debug(f"Exception in get_live_stream_url: {e}")
        return None


def get_vod_stream_url(channel_name: str, video_slug: str, quality: str = "auto") -> str | None:
    """
    Get the HLS stream URL for a Kick VOD.

    Args:
        channel_name: The Kick channel name
        video_slug: The video slug/UUID
        quality: The quality preference (auto, 1080p60, 720p60, etc.)

    Returns:
        The HLS stream URL or None if not found
    """
    try:
        from datetime import datetime, timedelta

        # Create cloudscraper session
        scraper = create_scraper(
            browser={
                'browser': 'chrome',
                'platform': 'windows',
                'desktop': True
            }
        )

        # Add headers
        scraper.headers.update({
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': f'https://kick.com/{channel_name}',
            'Origin': 'https://kick.com'
        })

        # Get channel videos
        api_url = f"https://kick.com/api/v2/channels/{channelName}/videos"
        log_debug(f"Fetching videos API: {api_url}")
        response = scraper.get(api_url, timeout=15)

        if response.status_code != 200:
            log_debug(f"Failed to get videos: status {response.status_code}")
            return None

        data = response.json()
        if not data or 'data' not in data:
            log_debug("No data in videos response")
            return None

        # Find the video by slug
        video = None
        for v in data['data'].get('videos', []):
            if v.get('uuid') == video_slug:
                video = v
                break

        if not video:
            log_debug(f"Video {video_slug} not found")
            return None

        log_debug(f"Found video: {video.get('uuid')}")

        # Parse thumbnail URL to extract channel_id and video_id
        thumbnail_url = video.get('thumbnail', {}).get('src', '')
        if not thumbnail_url:
            log_debug("No thumbnail URL in video data")
            return None

        log_debug(f"Thumbnail URL: {thumbnail_url}")
        thumbnail_parts = thumbnail_url.split('/')
        if len(thumbnail_parts) < 6:
            log_debug("Invalid thumbnail URL format")
            return None

        channel_id = thumbnail_parts[4]
        video_id = thumbnail_parts[5]

        log_debug(f"channel_id: {channel_id}, video_id: {video_id}")

        # Parse start time
        start_time = video.get('start_time')
        if not start_time:
            log_debug("No start_time in video data")
            return None

        # Generate VOD stream URL using the known pattern
        dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
        log_debug(f"Start time: {dt}")

        # Base URLs to try
        base_urls = [
            'https://stream.kick.com/ivs/v1/196233775518',
            'https://stream.kick.com/3c81249a5ce0/ivs/v1/196233775518',
            'https://stream.kick.com/0f3cb0ebce7/ivs/v1/196233775518'
        ]

        for offset in range(-5, 6):  # -5 to +5 minutes
            adjusted_time = dt + timedelta(minutes=offset)

            year = adjusted_time.year
            month = adjusted_time.month
            day = adjusted_time.day
            hour = adjusted_time.hour
            minute = adjusted_time.minute

            for base_url in base_urls:
                if quality == 'auto':
                    stream_url = f"{base_url}/{channel_id}/{year}/{month}/{day}/{hour}/{minute}/{video_id}/media/hls/master.m3u8"
                else:
                    stream_url = f"{base_url}/{channel_id}/{year}/{month}/{day}/{hour}/{minute}/{video_id}/media/hls/{quality}/playlist.m3u8"

                log_debug(f"Trying URL (offset {offset}): {stream_url}")

                # Test the URL
                try:
                    test_response = scraper.head(stream_url, timeout=5)
                    if test_response.status_code == 200:
                        log_debug(f"SUCCESS: Found valid stream URL!")
                        return stream_url
                except Exception as e:
                    log_debug(f"URL test failed: {e}")
                    continue

        log_debug("No valid URL found after trying all offsets and base URLs")
        return None

    except Exception as e:
        log_debug(f"Exception in get_vod_stream_url: {e}")
        return None


def get_video_stream_url(video_url: str, quality: str = "auto") -> str | None:
    """
    Get the HLS stream URL for a Kick video (live or VOD).

    Args:
        video_url: The Kick video URL (e.g., https://kick.com/mathematicien)
        quality: The quality preference (auto, 1080p60, 720p60, etc.)

    Returns:
        The HLS stream URL or None if not found
    """
    try:
        # Parse the URL to extract channel name
        parsed_url = urllib.parse.urlparse(video_url)
        path_parts = parsed_url.path.strip('/').split('/')

        if not path_parts:
            log_debug("No path parts in URL")
            return None

        channel_name = path_parts[0]
        log_debug(f"Channel name: {channel_name}")

        # Determine if it's a VOD URL
        is_vod = len(path_parts) >= 3 and path_parts[1] in ('video', 'videos')
        video_slug = path_parts[2] if is_vod else None

        if is_vod and video_slug:
            log_debug(f"VOD mode: video_slug={video_slug}")
            return get_vod_stream_url(channel_name, video_slug, quality)
        else:
            log_debug("Live mode")
            return get_live_stream_url(channel_name, quality)

    except Exception as e:
        log_debug(f"Exception in get_video_stream_url: {e}")
        return None


def main():
    """
    Main entry point for CLI usage.
    """
    if len(sys.argv) < 2:
        result = {
            "success": False,
            "error": "URL required",
            "url": None,
            "quality": None
        }
        print(json.dumps(result))
        return 1

    video_url = sys.argv[1]
    quality = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith('--') else "auto"

    log_debug(f"Fetching stream URL for: {video_url} (quality: {quality})")

    stream_url = get_video_stream_url(video_url, quality)

    result = {
        "url": stream_url,
        "quality": quality,
        "success": stream_url is not None
    }

    if not stream_url:
        result["error"] = "Could not retrieve stream URL (channel may not be live or URL is invalid)"

    print(json.dumps(result))
    return 0 if stream_url else 1


if __name__ == "__main__":
    sys.exit(main())
