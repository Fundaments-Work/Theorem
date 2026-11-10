These silent mono recordings are generated for native audiobook tests and
contain no third-party audio. To regenerate them:

```sh
ffmpeg -f lavfi -i anullsrc=r=22050:cl=mono -t 45 -codec:a libmp3lame -b:a 24k -y narration.mp3
ffmpeg -f lavfi -i anullsrc=r=22050:cl=mono -t 45 -codec:a aac -b:a 24k -movflags +faststart -y narration.m4a
ffmpeg -f lavfi -i anullsrc=r=48000:cl=mono -t 8 -codec:a libopus -b:a 24k -y narration.ogg
```
