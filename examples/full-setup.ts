import {
  activity,
  bind,
  button,
  command,
  defineRemote,
  delay,
  dock,
  driver,
  entity,
  integration,
  irCode,
  localCommand,
  macro,
  page,
  pairing,
  profile,
  ref,
  remote,
  resource,
  secret,
  settings,
} from "uc-config";

// Template only: replace hostnames, driver IDs, entity IDs and commands from inventory.
// Provisioning and dependent configuration are separate plan/apply phases.
const volume = command(ref("receiver"), "REPLACE_WITH_VOLUME_COMMAND");

export default defineRemote({
  schemaVersion: 1,
  resources: {
    device: settings("device", { name: "Living room" }),
    mediaDriver: driver("my-media-driver", {
      driver_url: "ws://media-driver.local:9090",
    }),
    media: integration({
      driver: ref("mediaDriver"),
      name: "Living room devices",
      // Inputs must match the selected driver's setup_data_schema.
      setup: { host: "receiver.local", token: secret("env:MEDIA_TOKEN", "v1") },
    }),
    receiver: entity({
      integration: ref("media"),
      entityId: "REPLACE_WITH_AVAILABLE_ENTITY_ID",
    }),
    chargingDock: dock({
      setup: {
        manually: {
          name: "Living room dock",
          custom_ws_url: "dock.local",
          token: secret("env:DOCK_TOKEN"),
        },
      },
      data: { name: "Living room dock" },
    }),
    television: remote({
      create: {
        name: { en: "TV" },
        custom_codeset: { manufacturer_id: "custom", device_name: "TV" },
      },
      data: { name: { en: "TV" } },
    }),
    // Use a learned/exported real code before applying this resource.
    tvPower: irCode(ref("television"), "POWER", {
      format: "PRONTO",
      value: "REPLACE_WITH_LEARNED_CODE",
    }),
    streamer: remote({
      create: { name: { en: "Streamer" }, kind: "BT", bt: {} },
      data: { name: { en: "Streamer" } },
    }),
    streamerPairing: pairing(ref("streamer")),
    streamerHome: bind(
      ref("streamer"),
      "HOME",
      localCommand("HOME"),
      "short_press",
      "remote",
    ),
    watchTV: activity({
      name: "Watch TV",
      entities: [ref("television"), ref("receiver"), ref("streamer")],
      on: [command(ref("television"), "POWER"), delay(1500)],
      options: { prevent_sleep: false },
    }),
    volumeUp: bind(ref("watchTV"), "VOLUME_UP", volume),
    controls: page(ref("watchTV"), {
      name: "Controls",
      grid: { width: 4, height: 6 },
      items: [
        button({
          label: "Home",
          at: [0, 0],
          size: [2, 1],
          command: command(ref("streamer"), "HOME"),
        }),
      ],
    }),
    mute: macro({
      name: "Mute",
      entities: [ref("receiver")],
      steps: [command(ref("receiver"), "REPLACE_WITH_MUTE_COMMAND")],
    }),
    family: profile({ name: "Family", restricted: false }),
    home: resource("profilePage", {
      parent: ref("family"),
      data: {
        name: "Home",
        items: [{ entity_id: ref("watchTV") }, { entity_id: ref("mute") }],
      },
    }),
  },
});
