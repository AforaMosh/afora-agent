package ai.afora.app.node

import ai.afora.app.protocol.AforaCalendarCommand
import ai.afora.app.protocol.AforaCallLogCommand
import ai.afora.app.protocol.AforaCameraCommand
import ai.afora.app.protocol.AforaCanvasA2UICommand
import ai.afora.app.protocol.AforaCanvasCommand
import ai.afora.app.protocol.AforaCapability
import ai.afora.app.protocol.AforaContactsCommand
import ai.afora.app.protocol.AforaDeviceCommand
import ai.afora.app.protocol.AforaLocationCommand
import ai.afora.app.protocol.AforaMobileUiCommand
import ai.afora.app.protocol.AforaMotionCommand
import ai.afora.app.protocol.AforaNotificationsCommand
import ai.afora.app.protocol.AforaPhotosCommand
import ai.afora.app.protocol.AforaSmsCommand
import ai.afora.app.protocol.AforaSystemCommand
import ai.afora.app.protocol.AforaTalkCommand

/** Runtime feature flags used to decide which node tools are advertised. */
data class NodeRuntimeFlags(
  val cameraEnabled: Boolean,
  val locationEnabled: Boolean,
  val sendSmsAvailable: Boolean,
  val readSmsAvailable: Boolean,
  val smsSearchPossible: Boolean,
  val callLogAvailable: Boolean,
  val photosAvailable: Boolean,
  val motionActivityAvailable: Boolean,
  val motionPedometerAvailable: Boolean,
  val installedAppsSharingEnabled: Boolean,
  val debugBuild: Boolean,
  val voiceWakeEnabled: Boolean = false,
  val mobileUiAvailable: Boolean = false,
)

/** Per-command availability gates checked before advertising invoke methods. */
enum class InvokeCommandAvailability {
  Always,
  CameraEnabled,
  LocationEnabled,
  SendSmsAvailable,
  ReadSmsAvailable,
  RequestableSmsSearchAvailable,
  CallLogAvailable,
  PhotosAvailable,
  MotionActivityAvailable,
  MotionPedometerAvailable,
  InstalledAppsSharingEnabled,
  DebugBuild,
  MobileUiAvailable,
}

/** Per-capability availability gates for the node capabilities manifest. */
enum class NodeCapabilityAvailability {
  Always,
  CameraEnabled,
  LocationEnabled,
  SmsAvailable,
  CallLogAvailable,
  PhotosAvailable,
  MotionAvailable,
  VoiceWakeEnabled,
  MobileUiAvailable,
}

/** Capability entry reported to the gateway when its availability gate passes. */
data class NodeCapabilitySpec(
  val name: String,
  val availability: NodeCapabilityAvailability = NodeCapabilityAvailability.Always,
)

/** Invoke method entry advertised to gateway plus foreground routing metadata. */
data class InvokeCommandSpec(
  val name: String,
  val requiresForeground: Boolean = false,
  val availability: InvokeCommandAvailability = InvokeCommandAvailability.Always,
)

object InvokeCommandRegistry {
  /** Capabilities mirror gateway protocol ids and are filtered by device state. */
  val capabilityManifest: List<NodeCapabilitySpec> =
    listOf(
      NodeCapabilitySpec(name = AforaCapability.Canvas.rawValue),
      NodeCapabilitySpec(name = AforaCapability.Device.rawValue),
      NodeCapabilitySpec(name = AforaCapability.Notifications.rawValue),
      NodeCapabilitySpec(name = AforaCapability.System.rawValue),
      NodeCapabilitySpec(
        name = AforaCapability.Camera.rawValue,
        availability = NodeCapabilityAvailability.CameraEnabled,
      ),
      NodeCapabilitySpec(
        name = AforaCapability.Sms.rawValue,
        availability = NodeCapabilityAvailability.SmsAvailable,
      ),
      NodeCapabilitySpec(name = AforaCapability.Talk.rawValue),
      NodeCapabilitySpec(
        name = AforaCapability.Location.rawValue,
        availability = NodeCapabilityAvailability.LocationEnabled,
      ),
      NodeCapabilitySpec(
        name = AforaCapability.Photos.rawValue,
        availability = NodeCapabilityAvailability.PhotosAvailable,
      ),
      NodeCapabilitySpec(name = AforaCapability.Contacts.rawValue),
      NodeCapabilitySpec(name = AforaCapability.Calendar.rawValue),
      NodeCapabilitySpec(
        name = AforaCapability.Motion.rawValue,
        availability = NodeCapabilityAvailability.MotionAvailable,
      ),
      NodeCapabilitySpec(
        name = AforaCapability.CallLog.rawValue,
        availability = NodeCapabilityAvailability.CallLogAvailable,
      ),
      NodeCapabilitySpec(
        name = AforaCapability.VoiceWake.rawValue,
        availability = NodeCapabilityAvailability.VoiceWakeEnabled,
      ),
      NodeCapabilitySpec(
        name = AforaCapability.MobileUI.rawValue,
        availability = NodeCapabilityAvailability.MobileUiAvailable,
      ),
    )

  /** Complete Android node command catalog before runtime availability filtering. */
  val all: List<InvokeCommandSpec> =
    listOf(
      InvokeCommandSpec(
        name = AforaCanvasCommand.Present.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = AforaCanvasCommand.Hide.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = AforaCanvasCommand.Navigate.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = AforaCanvasCommand.Eval.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = AforaCanvasCommand.Snapshot.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = AforaCanvasA2UICommand.Push.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = AforaCanvasA2UICommand.PushJSONL.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = AforaCanvasA2UICommand.Reset.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = AforaSystemCommand.Notify.rawValue,
      ),
      InvokeCommandSpec(
        name = AforaTalkCommand.PttStart.rawValue,
      ),
      InvokeCommandSpec(
        name = AforaTalkCommand.PttStop.rawValue,
      ),
      InvokeCommandSpec(
        name = AforaTalkCommand.PttCancel.rawValue,
      ),
      InvokeCommandSpec(
        name = AforaTalkCommand.PttOnce.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = AforaCameraCommand.List.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = AforaCameraCommand.Snap.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = AforaCameraCommand.Clip.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = AforaLocationCommand.Get.rawValue,
        availability = InvokeCommandAvailability.LocationEnabled,
      ),
      InvokeCommandSpec(
        name = AforaDeviceCommand.Status.rawValue,
      ),
      InvokeCommandSpec(
        name = AforaDeviceCommand.Info.rawValue,
      ),
      InvokeCommandSpec(
        name = AforaDeviceCommand.Permissions.rawValue,
      ),
      InvokeCommandSpec(
        name = AforaDeviceCommand.Health.rawValue,
      ),
      InvokeCommandSpec(
        name = AforaDeviceCommand.Apps.rawValue,
        availability = InvokeCommandAvailability.InstalledAppsSharingEnabled,
      ),
      InvokeCommandSpec(
        name = AforaNotificationsCommand.List.rawValue,
      ),
      InvokeCommandSpec(
        name = AforaNotificationsCommand.Actions.rawValue,
      ),
      InvokeCommandSpec(
        name = AforaPhotosCommand.Latest.rawValue,
        availability = InvokeCommandAvailability.PhotosAvailable,
      ),
      InvokeCommandSpec(
        name = AforaContactsCommand.Search.rawValue,
      ),
      InvokeCommandSpec(
        name = AforaContactsCommand.Add.rawValue,
      ),
      InvokeCommandSpec(
        name = AforaCalendarCommand.Events.rawValue,
      ),
      InvokeCommandSpec(
        name = AforaCalendarCommand.Add.rawValue,
      ),
      InvokeCommandSpec(
        name = AforaMotionCommand.Activity.rawValue,
        availability = InvokeCommandAvailability.MotionActivityAvailable,
      ),
      InvokeCommandSpec(
        name = AforaMotionCommand.Pedometer.rawValue,
        availability = InvokeCommandAvailability.MotionPedometerAvailable,
      ),
      InvokeCommandSpec(
        name = AforaSmsCommand.Send.rawValue,
        availability = InvokeCommandAvailability.SendSmsAvailable,
      ),
      InvokeCommandSpec(
        name = AforaSmsCommand.Search.rawValue,
        availability = InvokeCommandAvailability.RequestableSmsSearchAvailable,
      ),
      InvokeCommandSpec(
        name = AforaCallLogCommand.Search.rawValue,
        availability = InvokeCommandAvailability.CallLogAvailable,
      ),
      InvokeCommandSpec(
        name = AforaMobileUiCommand.Observe.rawValue,
        availability = InvokeCommandAvailability.MobileUiAvailable,
      ),
      InvokeCommandSpec(
        name = AforaMobileUiCommand.Act.rawValue,
        availability = InvokeCommandAvailability.MobileUiAvailable,
      ),
      InvokeCommandSpec(
        name = "debug.logs",
        availability = InvokeCommandAvailability.DebugBuild,
      ),
      InvokeCommandSpec(
        name = "debug.ed25519",
        availability = InvokeCommandAvailability.DebugBuild,
      ),
    )

  private val byNameInternal: Map<String, InvokeCommandSpec> = all.associateBy { it.name }

  /** Finds the command metadata used by dispatch and advertised-method builders. */
  fun find(command: String): InvokeCommandSpec? = byNameInternal[command]

  /** Returns gateway capability ids the current Android device can actually serve. */
  fun advertisedCapabilities(flags: NodeRuntimeFlags): List<String> =
    capabilityManifest
      .filter { spec ->
        when (spec.availability) {
          NodeCapabilityAvailability.Always -> true
          NodeCapabilityAvailability.CameraEnabled -> flags.cameraEnabled
          NodeCapabilityAvailability.LocationEnabled -> flags.locationEnabled
          NodeCapabilityAvailability.SmsAvailable -> flags.sendSmsAvailable || flags.readSmsAvailable
          NodeCapabilityAvailability.CallLogAvailable -> flags.callLogAvailable
          NodeCapabilityAvailability.PhotosAvailable -> flags.photosAvailable
          NodeCapabilityAvailability.MotionAvailable -> flags.motionActivityAvailable || flags.motionPedometerAvailable
          NodeCapabilityAvailability.VoiceWakeEnabled -> flags.voiceWakeEnabled
          NodeCapabilityAvailability.MobileUiAvailable -> flags.mobileUiAvailable
        }
      }.map { it.name }

  /** Returns gateway invoke method ids available under current permissions/build flags. */
  fun advertisedCommands(flags: NodeRuntimeFlags): List<String> =
    all
      .filter { spec ->
        when (spec.availability) {
          InvokeCommandAvailability.Always -> true
          InvokeCommandAvailability.CameraEnabled -> flags.cameraEnabled
          InvokeCommandAvailability.LocationEnabled -> flags.locationEnabled
          InvokeCommandAvailability.SendSmsAvailable -> flags.sendSmsAvailable
          InvokeCommandAvailability.ReadSmsAvailable -> flags.readSmsAvailable
          InvokeCommandAvailability.RequestableSmsSearchAvailable -> flags.smsSearchPossible
          InvokeCommandAvailability.CallLogAvailable -> flags.callLogAvailable
          InvokeCommandAvailability.PhotosAvailable -> flags.photosAvailable
          InvokeCommandAvailability.MotionActivityAvailable -> flags.motionActivityAvailable
          InvokeCommandAvailability.MotionPedometerAvailable -> flags.motionPedometerAvailable
          InvokeCommandAvailability.InstalledAppsSharingEnabled -> flags.installedAppsSharingEnabled
          InvokeCommandAvailability.DebugBuild -> flags.debugBuild
          InvokeCommandAvailability.MobileUiAvailable -> flags.mobileUiAvailable
        }
      }.map { it.name }
}
