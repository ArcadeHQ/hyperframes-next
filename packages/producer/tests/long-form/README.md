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
| 1     | `render a-single --fps 30 -w 4` (stock env)               | log `Parallel screenshot capture will stream to the encoder`; work dir < 2 GB; output 300.000 s |
| 2a    | `HF_SEGMENTED_CAPTURE=true render a-single --fps 30 -w 1` | `segment_*.mp4` in work dir; output 300.000 s; PSNR ≥ 45 dB vs the Phase 0 output               |
| 2b    | kill the 2a render at ~40 %, rerun with `--resume`        | log `resuming: N segments complete`; output byte-identical to an uninterrupted run              |
| 2c    | 2a with `HF_SEGMENT_BROWSER_RECYCLE=1`                    | one `[Render] segment browser recycled` line per segment; output unchanged                      |
| 2d    | 2a with `-w 4`                                            | four `segment worker` lines; output 300.000 s                                                   |

The Phase 0 mutation check is the same render with `PRODUCER_STREAMING_ENCODE_DURATION_CAP_ENABLED=true`: the gate line must flip to `"enabled":false,"reason":"duration_cap"` and the render must fail at the disk preflight on a host without ~75 GB free.

PSNR between two renders:

```sh
ffmpeg -i a.mp4 -i b.mp4 -lavfi "[0:v][1:v]psnr" -f null - 2>&1 | grep -o 'average:[0-9.inf]*'
```
