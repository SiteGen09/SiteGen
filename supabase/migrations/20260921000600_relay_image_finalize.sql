-- Serialize Relay completion with timeout/refund and settle within the same transaction.
CREATE OR REPLACE FUNCTION finish_relay_image(p_job_id uuid, p_storage_path text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j media_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM media_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR j.status NOT IN ('queued', 'running') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM channels WHERE id = j.channel_id AND provider = 'openai_images' AND base_url = 'https://relay.fast/v1') THEN
    RAISE EXCEPTION 'not a Relay image job';
  END IF;
  IF p_storage_path NOT LIKE j.user_id::text || '/' || j.id::text || '.%' THEN
    RAISE EXCEPTION 'invalid storage path';
  END IF;
  PERFORM settle_credits(j.request_id, j.credits_held, jsonb_build_object('kind', 'image', 'job_id', j.id, 'model', j.public_model_id));
  UPDATE media_jobs SET status = 'succeeded', storage_path = p_storage_path,
    credits_charged = j.credits_held, provider_result = NULL, completed_at = now(), updated_at = now()
    WHERE id = j.id;
END;
$$;
REVOKE ALL ON FUNCTION finish_relay_image(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION finish_relay_image(uuid, text) TO service_role;
NOTIFY pgrst, 'reload schema';
