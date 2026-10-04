// Starter configuration. For an existing remote, prefer generating
// remote.config.ts with `npm run uc -- import` instead of copying this file.
//
// Every entity ID and command below is a placeholder. Replace them with exact
// values from generated/devices.ts (written by `inventory --bindings`).
import {
  activity,
  bind,
  button,
  command,
  defineRemote,
  delay,
  page,
  ref,
} from "uc-config";

const tv = "REPLACE.main.media_player.TV_ID";
const receiver = "REPLACE.main.media_player.RECEIVER_ID";
const streamer = "REPLACE.main.media_player.STREAMER_ID";

export default defineRemote({
  schemaVersion: 1,
  resources: {
    "activity.watch_tv": activity({
      name: "Watch TV",
      entities: [tv, receiver, streamer],
      on: [
        command(tv, "media_player.on"),
        delay(1500),
        command(receiver, "media_player.on"),
      ],
      off: [
        command(receiver, "media_player.off"),
        command(tv, "media_player.off"),
      ],
    }),
    "activity.watch_tv.button.volume_up": bind(
      ref("activity.watch_tv"),
      "VOLUME_UP",
      command(receiver, "media_player.volume_up"),
    ),
    "activity.watch_tv.button.volume_down": bind(
      ref("activity.watch_tv"),
      "VOLUME_DOWN",
      command(receiver, "media_player.volume_down"),
    ),
    "activity.watch_tv.button.home": bind(
      ref("activity.watch_tv"),
      "HOME",
      command(streamer, "media_player.home"),
    ),
    "activity.watch_tv.page.main": page(ref("activity.watch_tv"), {
      name: "Main",
      grid: { width: 4, height: 6 },
      items: [
        button({
          label: "Play / Pause",
          at: [0, 0],
          size: [2, 1],
          command: command(streamer, "media_player.play_pause"),
        }),
      ],
    }),
  },
});
