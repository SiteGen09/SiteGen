import { videoScreeningAvailable } from '@/lib/safety/video-frames';
import type { MediaKind } from './jobs';

/**
 * Whether a kind of media can be generated on this deployment.
 *
 * Every request and every result passes the safety gate
 * (`lib/safety/media-gate.ts`), which fails closed on its own. This switch
 * decides only whether the feature is offered at all:
 * `MEDIA_GENERATION_ENABLED=true` turns on images, and video also needs
 * `MEDIA_VIDEO_ENABLED=true` plus ffmpeg, because a video is screened by
 * sampling its frames. Without ffmpeg an unscreened video would reach the
 * user, so video stays off.
 */
export function mediaAvailability(kind: MediaKind): { enabled: boolean; reason?: string } {
  if (process.env.MEDIA_GENERATION_ENABLED !== 'true') {
    return { enabled: false, reason: 'image and video generation is not enabled for this deployment' };
  }
  if (kind === 'video') {
    if (process.env.MEDIA_VIDEO_ENABLED !== 'true') {
      return { enabled: false, reason: 'video generation is not enabled for this deployment' };
    }
    if (!videoScreeningAvailable()) {
      return { enabled: false, reason: 'video generation is unavailable until its safety screening is installed' };
    }
  }
  return { enabled: true };
}
