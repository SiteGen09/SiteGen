/**
 * The wording of the image and video policy, shared by the server and the
 * chat workspace. Browser-safe: no server imports.
 */

/** The one message every refused request gets, whatever rule it broke. */
export const MEDIA_REFUSAL =
  'I can’t generate that. sitegen doesn’t allow adult content, anything involving minors, deepfakes, copyrighted material, hate, graphic violence, self-harm, or illegal activity. Please submit a different request.';

/** A finished render that failed the output check; the file is already gone. */
export const MEDIA_OUTPUT_REFUSAL =
  'I can’t show that result. It didn’t pass the safety check, so it was deleted and your credits were returned. Please submit a different request.';

export const MEDIA_POLICY_REQUIRED =
  'Agree to the Acceptable Use Policy before generating images or videos. You can do this in the dashboard chat.';

export const MEDIA_SUSPENDED =
  'Image and video generation is suspended on this account because of content-policy violations. Contact support if you think this is a mistake.';

export const MEDIA_SAFETY_UNAVAILABLE =
  'The safety check is temporarily unavailable, so nothing was generated and no credits were used. Please try again in a few minutes.';

/** Shown above the generate button. */
export const MEDIA_POLICY_WARNING =
  'Do not generate adult content, anything involving minors, deepfakes, copyrighted material, hate, graphic violence, self-harm, scams, weapons, drugs, or illegal activity. Violations can get your access removed.';

export const MEDIA_POLICY_CHECKBOX = 'I agree to the Acceptable Use Policy.';
