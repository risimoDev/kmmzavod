-- Infer the original workspace from the footage the batch actually selected.
-- The autopilot's current project may have changed since that batch ran.
WITH batch_projects AS (
  SELECT b.id, b.tenant_id, b.edit_project_id, b.uniquify_job_id,
         min(s.project_id::text)::uuid AS workspace_id
  FROM autopilot_batches b
  JOIN source_videos s ON s.id = ANY(b.source_video_ids) AND s.tenant_id = b.tenant_id
  JOIN projects p ON p.id = s.project_id AND p.tenant_id = b.tenant_id
  WHERE s.origin = 'upload'
  GROUP BY b.id
  HAVING count(DISTINCT s.project_id) = 1
),
editor_projects AS (
  SELECT tenant_id, edit_project_id, min(workspace_id::text)::uuid AS workspace_id
  FROM batch_projects
  WHERE edit_project_id IS NOT NULL
  GROUP BY tenant_id, edit_project_id
  HAVING count(DISTINCT workspace_id) = 1
),
updated_editors AS (
  UPDATE edit_projects ep
  SET config = jsonb_set(ep.config, '{workspaceProjectId}', to_jsonb(p.workspace_id), true)
  FROM editor_projects p
  WHERE ep.id = p.edit_project_id AND ep.tenant_id = p.tenant_id
    AND ep.config->>'workspaceProjectId' IS DISTINCT FROM p.workspace_id::text
),
masters AS (
  SELECT p.tenant_id, c.output_source_video_id AS source_video_id, p.workspace_id
  FROM editor_projects p
  JOIN edit_clips c ON c.project_id = p.edit_project_id
  WHERE c.output_source_video_id IS NOT NULL
  UNION ALL
  SELECT p.tenant_id, j.source_video_id, p.workspace_id
  FROM batch_projects p
  JOIN uniquify_jobs j ON j.id = p.uniquify_job_id AND j.tenant_id = p.tenant_id
),
master_projects AS (
  SELECT tenant_id, source_video_id, min(workspace_id::text)::uuid AS workspace_id
  FROM masters
  GROUP BY tenant_id, source_video_id
  HAVING count(DISTINCT workspace_id) = 1
)
UPDATE source_videos s
SET project_id = p.workspace_id, origin = 'autopilot'
FROM master_projects p
WHERE s.id = p.source_video_id AND s.tenant_id = p.tenant_id
  AND s.origin IN ('autopilot', 'editor')
  AND (s.project_id IS DISTINCT FROM p.workspace_id OR s.origin <> 'autopilot');
