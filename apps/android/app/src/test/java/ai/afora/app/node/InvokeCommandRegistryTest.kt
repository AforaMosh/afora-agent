package ai.afora.app.node

import ai.afora.app.protocol.AforaCalendarCommand
import ai.afora.app.protocol.AforaCallLogCommand
import ai.afora.app.protocol.AforaCameraCommand
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InvokeCommandRegistryTest {
  private val coreCapabilities =
    setOf(
      AforaCapability.Canvas.rawValue,
      AforaCapability.Device.rawValue,
      AforaCapability.Notifications.rawValue,
      AforaCapability.System.rawValue,
      AforaCapability.Talk.rawValue,
      AforaCapability.Contacts.rawValue,
      AforaCapability.Calendar.rawValue,
    )

  private val optionalCapabilities =
    setOf(
      AforaCapability.Camera.rawValue,
      AforaCapability.Location.rawValue,
      AforaCapability.Sms.rawValue,
      AforaCapability.CallLog.rawValue,
      AforaCapability.Motion.rawValue,
      AforaCapability.Photos.rawValue,
      AforaCapability.VoiceWake.rawValue,
      AforaCapability.MobileUI.rawValue,
    )

  private val coreCommands =
    setOf(
      AforaDeviceCommand.Status.rawValue,
      AforaDeviceCommand.Info.rawValue,
      AforaDeviceCommand.Permissions.rawValue,
      AforaDeviceCommand.Health.rawValue,
      AforaNotificationsCommand.List.rawValue,
      AforaNotificationsCommand.Actions.rawValue,
      AforaSystemCommand.Notify.rawValue,
      AforaTalkCommand.PttStart.rawValue,
      AforaTalkCommand.PttStop.rawValue,
      AforaTalkCommand.PttCancel.rawValue,
      AforaTalkCommand.PttOnce.rawValue,
      AforaContactsCommand.Search.rawValue,
      AforaContactsCommand.Add.rawValue,
      AforaCalendarCommand.Events.rawValue,
      AforaCalendarCommand.Add.rawValue,
    )

  private val optionalCommands =
    setOf(
      AforaCameraCommand.Snap.rawValue,
      AforaCameraCommand.Clip.rawValue,
      AforaCameraCommand.List.rawValue,
      AforaLocationCommand.Get.rawValue,
      AforaMotionCommand.Activity.rawValue,
      AforaMotionCommand.Pedometer.rawValue,
      AforaSmsCommand.Send.rawValue,
      AforaSmsCommand.Search.rawValue,
      AforaCallLogCommand.Search.rawValue,
      AforaPhotosCommand.Latest.rawValue,
      AforaMobileUiCommand.Observe.rawValue,
      AforaMobileUiCommand.Act.rawValue,
    )

  private val debugCommands = setOf("debug.logs", "debug.ed25519")

  @Test
  fun advertisedCapabilities_respectsFeatureAvailability() {
    val capabilities = InvokeCommandRegistry.advertisedCapabilities(defaultFlags())

    assertContainsAll(capabilities, coreCapabilities)
    assertMissingAll(capabilities, optionalCapabilities)
  }

  @Test
  fun advertisedCapabilities_includesFeatureCapabilitiesWhenEnabled() {
    val capabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        defaultFlags(
          cameraEnabled = true,
          locationEnabled = true,
          sendSmsAvailable = true,
          readSmsAvailable = true,
          smsSearchPossible = true,
          callLogAvailable = true,
          photosAvailable = true,
          motionActivityAvailable = true,
          motionPedometerAvailable = true,
          voiceWakeEnabled = true,
          mobileUiAvailable = true,
        ),
      )

    assertContainsAll(capabilities, coreCapabilities + optionalCapabilities)
  }

  @Test
  fun advertisedCommands_respectsFeatureAvailability() {
    val commands = InvokeCommandRegistry.advertisedCommands(defaultFlags())

    assertContainsAll(commands, coreCommands)
    assertMissingAll(commands, optionalCommands + debugCommands)
  }

  @Test
  fun advertisedCommands_includesDeviceAppsOnlyWhenUserOptedIn() {
    val disabled = InvokeCommandRegistry.advertisedCommands(defaultFlags(installedAppsSharingEnabled = false))
    val enabled = InvokeCommandRegistry.advertisedCommands(defaultFlags(installedAppsSharingEnabled = true))

    assertFalse(disabled.contains(AforaDeviceCommand.Apps.rawValue))
    assertTrue(enabled.contains(AforaDeviceCommand.Apps.rawValue))
  }

  @Test
  fun advertisedCommands_includesFeatureCommandsWhenEnabled() {
    val commands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(
          cameraEnabled = true,
          locationEnabled = true,
          sendSmsAvailable = true,
          readSmsAvailable = true,
          smsSearchPossible = true,
          callLogAvailable = true,
          photosAvailable = true,
          motionActivityAvailable = true,
          motionPedometerAvailable = true,
          debugBuild = true,
          mobileUiAvailable = true,
        ),
      )

    assertContainsAll(commands, coreCommands + optionalCommands + debugCommands)
  }

  @Test
  fun advertisedCommands_onlyIncludesSupportedMotionCommands() {
    val commands =
      InvokeCommandRegistry.advertisedCommands(
        NodeRuntimeFlags(
          cameraEnabled = false,
          locationEnabled = false,
          sendSmsAvailable = false,
          readSmsAvailable = false,
          smsSearchPossible = false,
          callLogAvailable = false,
          photosAvailable = false,
          motionActivityAvailable = true,
          motionPedometerAvailable = false,
          installedAppsSharingEnabled = false,
          debugBuild = false,
        ),
      )

    assertTrue(commands.contains(AforaMotionCommand.Activity.rawValue))
    assertFalse(commands.contains(AforaMotionCommand.Pedometer.rawValue))
  }

  @Test
  fun advertisedCommands_splitsSmsSendAndSearchAvailability() {
    val readOnlyCommands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(readSmsAvailable = true, smsSearchPossible = true),
      )
    val sendOnlyCommands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(sendSmsAvailable = true),
      )
    val requestableSearchCommands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(smsSearchPossible = true),
      )

    assertTrue(readOnlyCommands.contains(AforaSmsCommand.Search.rawValue))
    assertFalse(readOnlyCommands.contains(AforaSmsCommand.Send.rawValue))
    assertTrue(sendOnlyCommands.contains(AforaSmsCommand.Send.rawValue))
    assertFalse(sendOnlyCommands.contains(AforaSmsCommand.Search.rawValue))
    assertTrue(requestableSearchCommands.contains(AforaSmsCommand.Search.rawValue))
  }

  @Test
  fun advertisedCapabilities_includeSmsWhenEitherSmsPathIsAvailable() {
    val readOnlyCapabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        defaultFlags(readSmsAvailable = true),
      )
    val sendOnlyCapabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        defaultFlags(sendSmsAvailable = true),
      )
    val requestableSearchCapabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        defaultFlags(smsSearchPossible = true),
      )

    assertTrue(readOnlyCapabilities.contains(AforaCapability.Sms.rawValue))
    assertTrue(sendOnlyCapabilities.contains(AforaCapability.Sms.rawValue))
    assertFalse(requestableSearchCapabilities.contains(AforaCapability.Sms.rawValue))
  }

  @Test
  fun advertisedCommands_excludesCallLogWhenUnavailable() {
    val commands = InvokeCommandRegistry.advertisedCommands(defaultFlags(callLogAvailable = false))

    assertFalse(commands.contains(AforaCallLogCommand.Search.rawValue))
  }

  @Test
  fun advertisedCapabilities_excludesCallLogWhenUnavailable() {
    val capabilities = InvokeCommandRegistry.advertisedCapabilities(defaultFlags(callLogAvailable = false))

    assertFalse(capabilities.contains(AforaCapability.CallLog.rawValue))
  }

  @Test
  fun advertisedPhotosSurface_respectsFeatureAvailability() {
    val disabledFlags = defaultFlags(photosAvailable = false)
    val enabledFlags = defaultFlags(photosAvailable = true)

    assertFalse(InvokeCommandRegistry.advertisedCapabilities(disabledFlags).contains(AforaCapability.Photos.rawValue))
    assertFalse(InvokeCommandRegistry.advertisedCommands(disabledFlags).contains(AforaPhotosCommand.Latest.rawValue))
    assertTrue(InvokeCommandRegistry.advertisedCapabilities(enabledFlags).contains(AforaCapability.Photos.rawValue))
    assertTrue(InvokeCommandRegistry.advertisedCommands(enabledFlags).contains(AforaPhotosCommand.Latest.rawValue))
  }

  @Test
  fun find_returnsForegroundMetadataForCameraCommands() {
    val list = InvokeCommandRegistry.find(AforaCameraCommand.List.rawValue)
    val location = InvokeCommandRegistry.find(AforaLocationCommand.Get.rawValue)
    val pttStart = InvokeCommandRegistry.find(AforaTalkCommand.PttStart.rawValue)
    val pttStop = InvokeCommandRegistry.find(AforaTalkCommand.PttStop.rawValue)
    val pttCancel = InvokeCommandRegistry.find(AforaTalkCommand.PttCancel.rawValue)
    val pttOnce = InvokeCommandRegistry.find(AforaTalkCommand.PttOnce.rawValue)

    assertNotNull(list)
    assertEquals(true, list?.requiresForeground)
    assertNotNull(location)
    assertEquals(false, location?.requiresForeground)
    assertNotNull(pttStart)
    assertEquals(false, pttStart?.requiresForeground)
    assertNotNull(pttStop)
    assertEquals(false, pttStop?.requiresForeground)
    assertNotNull(pttCancel)
    assertEquals(false, pttCancel?.requiresForeground)
    assertNotNull(pttOnce)
    assertEquals(true, pttOnce?.requiresForeground)
  }

  @Test
  fun find_returnsNullForUnknownCommand() {
    assertNull(InvokeCommandRegistry.find("not.real"))
  }

  private fun defaultFlags(
    cameraEnabled: Boolean = false,
    locationEnabled: Boolean = false,
    sendSmsAvailable: Boolean = false,
    readSmsAvailable: Boolean = false,
    smsSearchPossible: Boolean = false,
    callLogAvailable: Boolean = false,
    photosAvailable: Boolean = false,
    motionActivityAvailable: Boolean = false,
    motionPedometerAvailable: Boolean = false,
    installedAppsSharingEnabled: Boolean = false,
    debugBuild: Boolean = false,
    voiceWakeEnabled: Boolean = false,
    mobileUiAvailable: Boolean = false,
  ): NodeRuntimeFlags =
    NodeRuntimeFlags(
      cameraEnabled = cameraEnabled,
      locationEnabled = locationEnabled,
      sendSmsAvailable = sendSmsAvailable,
      readSmsAvailable = readSmsAvailable,
      smsSearchPossible = smsSearchPossible,
      callLogAvailable = callLogAvailable,
      photosAvailable = photosAvailable,
      motionActivityAvailable = motionActivityAvailable,
      motionPedometerAvailable = motionPedometerAvailable,
      installedAppsSharingEnabled = installedAppsSharingEnabled,
      debugBuild = debugBuild,
      voiceWakeEnabled = voiceWakeEnabled,
      mobileUiAvailable = mobileUiAvailable,
    )

  private fun assertContainsAll(
    actual: List<String>,
    expected: Set<String>,
  ) {
    expected.forEach { value -> assertTrue(actual.contains(value)) }
  }

  private fun assertMissingAll(
    actual: List<String>,
    forbidden: Set<String>,
  ) {
    forbidden.forEach { value -> assertFalse(actual.contains(value)) }
  }
}
