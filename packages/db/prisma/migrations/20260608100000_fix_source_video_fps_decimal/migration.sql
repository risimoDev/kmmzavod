-- Change SourceVideo.fps from smallint to numeric(5,2) to store fractional FPS values
-- (e.g. 29.97, 23.976) returned by the video-processor analysis endpoint.
ALTER TABLE "source_videos" ALTER COLUMN "fps" TYPE numeric(5,2) USING "fps"::numeric(5,2);
