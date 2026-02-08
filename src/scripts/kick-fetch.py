#!/usr/bin/env python3
"""
Kick stream fetcher using cloudscraper to bypass Cloudflare protection.
Now supports quality selection by parsing HLS master playlists.
"""

import sys
import json
import urllib.parse
import re

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


def parse_m3u8_master_playlist(content: str) -> list:
    """
    Parse M3U8 master playlist to extract stream variants.
    Returns list of stream dictionaries with quality info.
    """
    streams = []
    lines = content.strip().split('\n')
    current_stream = {}

    for line in lines:
        line = line.strip()

        # Skip empty lines and comments (except EXT-X-STREAM-INF)
        if not line:
            continue

        if line.startswith('#EXT-X-STREAM-INF:'):
            current_stream = {}

            # Parse the STREAM-INF attributes
            # Format: #EXT-X-STREAM-INF:BANDWIDTH=123456,RESOLUTION=1920x1080,CODECS="...",FRAME-RATE=60
            ext_inf = line.replace('#EXT-X-STREAM-INF:', '').strip()

            # Parse all key=value pairs
            for match in re.finditer(r'(\w+)=([^,]+)', ext_inf):
                key = match.group(1)
                value = match.group(2).strip('"\'')
                current_stream[key] = value

                # Convert to appropriate types
                if key == 'BANDWIDTH':
                    current_stream[key] = int(value)
                elif key == 'RESOLUTION':
                    current_stream['width'] = int(value.split('x')[0])
                    current_stream['height'] = int(value.split('x')[1])
                elif key == 'FRAME-RATE':
                    current_stream[key] = float(value)

        elif not line.startswith('#') and current_stream:
            # This is a URL line
            current_stream['url'] = line
            streams.append(current_stream)
            current_stream = {}

    return streams


def select_stream_by_quality(streams: list, preferred_quality: str):
    """
    Select the best stream based on quality preference.

    Quality formats:
    - 'auto': select the stream with highest bandwidth
    - '1080p60': width=1920, height=1080, framerate=60
    - '720p60': width=1280, height=720, framerate=60
    - '480p30': width=854, height=480, framerate=30
    - '360p30': width=640, height=360, framerate=30
    - '160p30': width=284, height=160, framerate=30
    """
    if not streams:
        return None

    if preferred_quality == 'auto':
        # Select stream with highest bandwidth
        return max(streams, key=lambda s: s.get('BANDWIDTH', 0))

    # Parse quality string
    # Format: "1080p60" or "720p60" etc.
    match = re.match(r'(\d+)p(\d+)', preferred_quality)
    if not match:
        return streams[0]

    target_height = int(match.group(1))
    target_fps = float(match.group(2))

    # Find exact match
    exact_match = None
    for stream in streams:
        if (stream.get('height') == target_height and
            stream.get('FRAME-RATE', 30) == target_fps):
            exact_match = stream
            break

    if exact_match:
        return exact_match

    # Find closest match by height
    sorted_streams = sorted(streams,
                           key=lambda s: abs(s.get('height', 720) - target_height))

    return sorted_streams[0]


def get_live_stream_url(channel_name: str, quality: str = "auto") -> dict:
    """
    Get the HLS stream URL for a live Kick channel with quality selection.

    Args:
        channel_name: The Kick channel name
        quality: The quality preference (auto, 1080p60, 720p60, etc.)

    Returns:
        Dict with url, quality, and available_qualities
    """
    result = {
        'url': None,
        'quality': quality,
        'available_qualities': [],
        'error': None
    }

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
                            # For fallback, return the master URL as is
                            result['url'] = hls_url
                            return result
            result['error'] = "Could not retrieve stream URL from API"
            return result

        data = response.json()
        log_debug(f"Livestream response: {json.dumps(data, indent=2)}")

        if not data or 'data' not in data:
            log_debug("No data in response")
            result['error'] = "No data in API response"
            return result

        # Check both structures:
        # 1. New structure: data.playback_url (direct under data)
        # 2. Old structure: data.livestream.hls_playlist_url
        livestream = data['data']

        # Try playback_url first (new API structure)
        master_url = livestream.get('playback_url')
        if not master_url:
            # Try the nested livestream structure (old API structure)
            nested_livestream = data['data'].get('livestream')
            if nested_livestream:
                master_url = nested_livestream.get('playback_url') or nested_livestream.get('hls_playlist_url')

        if not master_url:
            log_debug("No HLS playlist URL found in livestream data")
            result['error'] = "No HLS playlist URL in API response"
            return result

        log_debug(f"Found master HLS URL: {master_url}")

        # Parse the master playlist to get all available qualities
        m3u8_response = scraper.get(master_url, timeout=15)
        if m3u8_response.status_code != 200:
            log_debug(f"Failed to fetch HLS playlist: {m3u8_response.status_code}")
            result['error'] = f"Failed to fetch HLS playlist: {m3u8_response.status_code}"
            return result

        m3u8_content = m3u8_response.text
        streams = parse_m3u8_master_playlist(m3u8_content)

        if not streams:
            log_debug("No stream variants found in HLS playlist, returning master URL")
            # Fallback to master URL if no variants found
            result['url'] = master_url
            return result

        log_debug(f"Found {len(streams)} stream variants")

        # Build available qualities list
        for stream in streams:
            height = stream.get('height')
            fps = stream.get('FRAME-RATE', 30)
            if height:
                quality_label = f"{height}p{int(fps)}"
                if quality_label not in result['available_qualities']:
                    result['available_qualities'].append(quality_label)
        result['available_qualities'].sort()

        # Select stream based on quality preference
        selected_stream = select_stream_by_quality(streams, quality)

        if selected_stream:
            # Construct full URL if the stream URL is relative
            stream_url = selected_stream['url']
            if not stream_url.startswith('http'):
                # Handle relative URLs
                base_url = master_url.rsplit('/', 1)[0]
                stream_url = f"{base_url}/{stream_url}"

            result['url'] = stream_url

            # Update selected quality label
            height = selected_stream.get('height')
            fps = selected_stream.get('FRAME-RATE', 30)
            if height:
                result['quality'] = f"{height}p{int(fps)}"

            log_debug(f"Selected stream: {result['quality']} - {stream_url}")
        else:
            # Fallback to master URL
            result['url'] = master_url
            log_debug("No matching stream, returning master URL")

        return result

    except Exception as e:
        log_debug(f"Exception in get_live_stream_url: {e}")
        result['error'] = str(e)
        return result


def get_vod_stream_url(channel_name: str, video_slug: str, quality: str = "auto") -> dict:
    """
    Get the HLS stream URL for a Kick VOD with quality selection.

    Args:
        channel_name: The Kick channel name
        video_slug: The video slug/UUID
        quality: The quality preference (auto, 1080p60, 720p60, etc.)

    Returns:
        Dict with url, quality, and available_qualities
    """
    result = {
        'url': None,
        'quality': quality,
        'available_qualities': [],
        'error': None
    }

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
            result['error'] = f"Failed to get videos: {response.status_code}"
            return result

        data = response.json()
        if not data or 'data' not in data:
            log_debug("No data in videos response")
            result['error'] = "No data in videos response"
            return result

        # Find the video by slug
        video = None
        for v in data['data'].get('videos', []):
            if v.get('uuid') == video_slug:
                video = v
                break

        if not video:
            log_debug(f"Video {video_slug} not found")
            result['error'] = f"Video {video_slug} not found"
            return result

        log_debug(f"Found video: {video.get('uuid')}")

        # Parse thumbnail URL to extract channel_id and video_id
        thumbnail_url = video.get('thumbnail', {}).get('src', '')
        if not thumbnail_url:
            log_debug("No thumbnail URL in video data")
            result['error'] = "No thumbnail URL in video data"
            return result

        log_debug(f"Thumbnail URL: {thumbnail_url}")
        thumbnail_parts = thumbnail_url.split('/')
        if len(thumbnail_parts) < 6:
            log_debug("Invalid thumbnail URL format")
            result['error'] = "Invalid thumbnail URL format"
            return result

        channel_id = thumbnail_parts[4]
        video_id = thumbnail_parts[5]

        log_debug(f"channel_id: {channel_id}, video_id: {video_id}")

        # Parse start time
        start_time = video.get('start_time')
        if not start_time:
            log_debug("No start_time in video data")
            result['error'] = "No start_time in video data"
            return result

        # Generate VOD stream URL using the known pattern
        dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
        log_debug(f"Start time: {dt}")

        # Base URLs to try
        base_urls = [
            'https://stream.kick.com/ivs/v1/196233775518',
            'https://stream.kick.com/3c81249a5ce0/ivs/v1/196233775518',
            'https://stream.kick.com/0f3cb0ebce7/ivs/v1/196233775518'
        ]

        # Try to find the master playlist first
        master_url = None

        for offset in range(-5, 6):  # -5 to +5 minutes
            adjusted_time = dt + timedelta(minutes=offset)

            year = adjusted_time.year
            month = adjusted_time.month
            day = adjusted_time.day
            hour = adjusted_time.hour
            minute = adjusted_time.minute

            for base_url in base_urls:
                # Try master playlist URL
                url = f"{base_url}/{channel_id}/{year}/{month}/{day}/{hour}/{minute}/{video_id}/media/hls/master.m3u8"

                log_debug(f"Trying master URL (offset {offset}): {url}")

                try:
                    test_response = scraper.head(url, timeout=5)
                    if test_response.status_code == 200:
                        log_debug(f"SUCCESS: Found valid master playlist URL!")
                        master_url = url
                        break
                except Exception as e:
                    log_debug(f"URL test failed: {e}")
                    continue

            if master_url:
                break

        if not master_url:
            log_debug("No valid master URL found")
            result['error'] = "No valid master URL found"
            return result

        # Parse the master playlist to get all available qualities
        m3u8_response = scraper.get(master_url, timeout=15)
        if m3u8_response.status_code != 200:
            log_debug(f"Failed to fetch HLS playlist: {m3u8_response.status_code}")
            # Fallback to direct quality URL construction
            stream_url = f"{master_url.rsplit('/master.m3u8', 1)[0]}/{quality}/playlist.m3u8"
            result['url'] = stream_url
            return result

        m3u8_content = m3u8_response.text
        streams = parse_m3u8_master_playlist(m3u8_content)

        if not streams:
            log_debug("No stream variants found in HLS playlist")
            result['error'] = "No stream variants found in HLS playlist"
            return result

        log_debug(f"Found {len(streams)} stream variants")

        # Build available qualities list
        for stream in streams:
            height = stream.get('height')
            fps = stream.get('FRAME-RATE', 30)
            if height:
                quality_label = f"{height}p{int(fps)}"
                if quality_label not in result['available_qualities']:
                    result['available_qualities'].append(quality_label)
        result['available_qualities'].sort()

        # Select stream based on quality preference
        selected_stream = select_stream_by_quality(streams, quality)

        if selected_stream:
            # Construct full URL if the stream URL is relative
            stream_url = selected_stream['url']
            if not stream_url.startswith('http'):
                # Handle relative URLs
                base_url = master_url.rsplit('/', 1)[0]
                stream_url = f"{base_url}/{stream_url}"

            result['url'] = stream_url

            # Update selected quality label
            height = selected_stream.get('height')
            fps = selected_stream.get('FRAME-RATE', 30)
            if height:
                result['quality'] = f"{height}p{int(fps)}"

            log_debug(f"Selected stream: {result['quality']} - {stream_url}")
        else:
            result['error'] = "No matching stream found"
            return result

        return result

    except Exception as e:
        log_debug(f"Exception in get_vod_stream_url: {e}")
        result['error'] = str(e)
        return result


def get_video_stream_url(video_url: str, quality: str = "auto") -> dict:
    """
    Get the HLS stream URL for a Kick video (live or VOD) with quality selection.

    Args:
        video_url: The Kick video URL (e.g., https://kick.com/mathematicien)
        quality: The quality preference (auto, 1080p60, 720p60, etc.)

    Returns:
        Dict with url, quality, and available_qualities
    """
    try:
        # Parse the URL to extract channel name
        parsed_url = urllib.parse.urlparse(video_url)
        path_parts = parsed_url.path.strip('/').split('/')

        if not path_parts:
            log_debug("No path parts in URL")
            return {
                'url': None,
                'quality': quality,
                'available_qualities': [],
                'error': "No path parts in URL"
            }

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
        return {
            'url': None,
            'quality': quality,
            'available_qualities': [],
            'error': str(e)
        }


def main():
    """
    Main entry point for CLI usage.
    """
    if len(sys.argv) < 2:
        result = {
            "success": False,
            "error": "URL required",
            "url": None,
            "quality": None,
            "available_qualities": []
        }
        print(json.dumps(result))
        return 1

    video_url = sys.argv[1]
    quality = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith('--') else "auto"

    log_debug(f"Fetching stream URL for: {video_url} (quality: {quality})")

    stream_result = get_video_stream_url(video_url, quality)

    result = {
        "url": stream_result['url'],
        "quality": stream_result['quality'],
        "available_qualities": stream_result['available_qualities'],
        "success": stream_result['url'] is not None
    }

    if not stream_result['url'] and stream_result['error']:
        result["error"] = stream_result['error']

    print(json.dumps(result))
    return 0 if stream_result['url'] else 1


if __name__ == "__main__":
    sys.exit(main())
