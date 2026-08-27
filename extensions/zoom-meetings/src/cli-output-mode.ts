import { MeetingPlatformAdapter } from "afora-agent/plugin-sdk/meeting-runtime";

export const ZOOM_MEETINGS_CLI_METADATA = MeetingPlatformAdapter.createCliMetadata({
  commandName: "zoommeetings",
  description: "Join and manage Zoom meeting guests",
  id: "zoom-meetings",
  name: "Zoom meetings",
});
