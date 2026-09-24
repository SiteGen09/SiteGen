import type { MediaKind } from './jobs';

/**
 * Media output is only exposed when the deployment has an explicit safety
 * configuration. Video stays unavailable until the service has a supported
 * output-screening path; the current moderation integration can screen text and
 * still images, not video.
 */
export function mediaAvailability(kind: MediaKind): { enabled: boolean; reason?: string } {
  if (kind === 'video') {
    return { enabled: false, reason: 'video generation is temporarily unavailable while output screening is being configured' };
  }
  if (process.env.MEDIA_GENERATION_ENABLED !== 'true') {
    return { enabled: false, reason: 'image generation is not enabled for this deployment' };
  }
  if (
    process.env.MODERATION_MODE !== 'remote' ||
    process.env.MEDIA_OUTPUT_MODERATION !== 'remote' ||
    process.env.MEDIA_OUTPUT_MODERATION_READY !== 'true' ||
    !process.env.MODERATION_API_KEY?.trim()
  ) {
    return { enabled: false, reason: 'image generation requires tested remote prompt and output moderation' };
  }
  return { enabled: true };
}
