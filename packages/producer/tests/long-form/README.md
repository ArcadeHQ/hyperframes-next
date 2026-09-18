# Long-form render fixtures

Manual gates for `plans/long-form-render/`. Not part of the automated lanes (they render for minutes and need ~600 MB of source).

## Generate the source once

```sh
mkdir -p /tmp/hf-longform/assets && cd /tmp/hf-longform
ffmpeg -y -f lavfi -i "testsrc2=size=1920x1080:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t 300 -c:v libx264 -preset ultrafast -crf 23 -g 30 -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart assets/long.mp4
node <repo>/packages/producer/tests/long-form/gen.mjs
```

For the 40-minute soak fixture use `-t 2400` and `DUR=2400 node .../gen.mjs`.

## Run a gate against the worktree build

```sh
cd <repo> && bun run build
cd /tmp/hf-longform
node <repo>/packages/cli/dist/cli.js render a-single --fps 30 -w 1 --quality draft -o a-single/renders/out.mp4
```

Check duration: `ffprobe -v error -show_entries format=duration -of csv=p=0 a-single/renders/out.mp4` → `300.000000`.

Never run two of these concurrently on a dev Mac — the fleet limit is why the gates are sequential.

## Gates by phase

| Phase | Command                                                   | Expect                                                                                          |
| ----- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0     | `render a-single --fps 30 -w 1` (stock env)               | log `streaming-encode gate {"enabled":true,"reason":"single_worker",...}`; output 300.000 s     |
| 1     | `render a-single --fps 30 -w 4` (stock env, Linux BeginFrame) | log `Parallel screenshot capture will stream to the encoder`; work dir < 2 GB; output 300.000 s. On macOS/Windows the default holds this back — stock `-w 4` must fail the disk preflight, and `HF_CAPTURE_PARALLEL_STREAM=true` must then route it (`reason: parallel_forced`) |
| 2a    | `HF_SEGMENTED_CAPTURE=true HF_SEGMENT_FRAMES=1500 render a-single --fps 30 -w 1` | log `Segmented capture complete: 6 segment(s)`; output 300.000 s and exactly 9000 frames; no per-frame PSNR dip at a segment boundary (see below) |
| 2b    | kill the 2a render at ~40 %, rerun with `--resume`        | log `resuming: N segments complete` + N × `segment skipped (resume)`; output byte-identical to an uninterrupted run; the segment dir is gone afterwards unless `--keep-segments` |
| 2c    | 2a with `HF_SEGMENT_BROWSER_RECYCLE=1`                    | one `[Render] segment browser recycled` line per segment; output unchanged                      |
| 2d    | 2a with `-w 4`                                            | four `segment worker` lines; output 300.000 s                                                   |

The Phase 0 mutation check is the same render with `PRODUCER_STREAMING_ENCODE_DURATION_CAP_ENABLED=true`: the gate line must flip to `"enabled":false,"reason":"duration_cap"` and the render must fail at the disk preflight on a host without ~75 GB free.

### Interrupting the 2b run

Kill on the manifest, not on a log line — the manifest is the resume contract:

```sh
HF_SEGMENTED_CAPTURE=true HF_SEGMENT_FRAMES=1500 node <repo>/packages/cli/dist/cli.js \
  render a-single --fps 30 -w 1 --quality draft -o a-single/renders/resumed.mp4 & RPID=$!
until [ "$(python3 -c "import json,glob;f=glob.glob('a-single/renders/.hf-segments/*/segments.json');print(len(json.load(open(f[0]))['completed']) if f else 0)")" -ge 2 ]; do sleep 1; done
kill -9 $RPID
```

A kill mid-segment leaves a tiny partial `segment_0000N.mp4` that is NOT in the
manifest — resume must re-capture it. Measured 2026-09-17: killed at 2 of 6,
resume logged `resuming: 2 segments complete`, finished in 3 m 32 s against
5 m 13 s uninterrupted, and the output was byte-identical to the full render
(whole file, not just the video stream).

Verify byte-identity:

```sh
cmp full.mp4 resumed.mp4 && echo BYTE_IDENTICAL
# if only container metadata differs, compare the video stream instead:
ffmpeg -v error -i full.mp4 -map 0:v -c copy -f md5 -
```

This gate is also the only check on the CLI flag wiring: `--resume` and
`--keep-segments` cross plan → options → request → config, and a dropped
hand-off there silently renders without resuming.

PSNR between two renders:

```sh
ffmpeg -i a.mp4 -i b.mp4 -lavfi "[0:v][1:v]psnr" -f null - 2>&1 | grep -o 'average:[0-9.inf]*'
```

### Reading the segmented-capture PSNR

The average against a single-encoder reference is **not** the criterion, and the
spec's "≥ 45 dB" reads as a failure when nothing is wrong. Two independent CRF
encodes of identical frames differ anyway, and segmented capture additionally
forces a closed GOP with scene-cut detection off, which costs roughly another
dB. Measured 2026-09-17 on the 300 s fixture: average 44.4 dB, median 44.3,
minimum 42.97, frame count and duration both exact.

What actually detects a boundary defect is the per-frame series, so compare
that instead:

```sh
ffmpeg -i ref.mp4 -i phase2a.mp4 -lavfi "[0:v][1:v]psnr=stats_file=/tmp/psnr.log" -f null -
grep -oE 'n:[0-9]+ .*psnr_avg:[0-9.inf]+' /tmp/psnr.log | sort -t: -k5 -n | head
```

Healthy output has its **highest** PSNR at the boundary frames — they are
forced IDRs, so they encode more faithfully than their neighbours (measured
48–62 dB at n = 1501, 3001, 4501, 6001, 7501 with `HF_SEGMENT_FRAMES=1500`).
A dip at exactly those indices is the failure this gate is looking for.

### Known cost: segmented capture is slower

The segmented stage runs the plain `captureFrameToBuffer` loop, while the
single-encoder streaming stage uses the depth-2 worker-encode pipeline when the
session supports it. On the 300 s fixture that is 5 m 16 s segmented vs 2 m 43 s
streaming (both drawElement capture). Segmentation buys bounded scratch,
resumability and blast radius, not speed; threading the worker-encode loop
through the segmented stage is the follow-up that would close the gap.
