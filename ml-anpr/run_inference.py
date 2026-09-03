"""Simple CLI wrapper around anpr.streaming.process_video_file, for
running the pipeline against a single video file from the command line
(e.g. on the GPU server, where there's no interactive Python session).

The real pipeline is normally used via Python function calls
(anpr.streaming.process_video_file / process_stream / process_hls_stream,
or anpr.pipeline.orchestrator.ScalablePipeline for the multi-camera
scalable version) -- this script exists only to give a plain
`python run_inference.py --source ... --camera-id ...` command line for
one-off runs, matching how every other tool in this project's
deployment docs is invoked.
"""
import argparse
import sys

from anpr.streaming import process_video_file


def main():
    parser = argparse.ArgumentParser(description="Run the ANPR pipeline on a single video file.")
    parser.add_argument("--source", required=True, help="Path to the input video file")
    parser.add_argument("--camera-id", default="test-cam", help="camera_id string passed to the tracker/backend")
    parser.add_argument("--sample-rate", type=int, default=15,
                         help="Process every Nth frame (matches process_every_n_frames)")
    parser.add_argument("--confirm-threshold", type=int, default=2)
    args = parser.parse_args()

    print(f"Running inference: source={args.source} camera_id={args.camera_id} "
          f"sample_rate={args.sample_rate}", file=sys.stderr)
    process_video_file(
        args.source, args.camera_id,
        process_every_n_frames=args.sample_rate,
        confirm_threshold=args.confirm_threshold,
    )


if __name__ == "__main__":
    main()
