package ai.afora.app.protocol

import org.junit.Assert.assertTrue
import org.junit.Test

class AforaProtocolConstantsTest {
  @Test
  fun generatedCapabilitiesAreUniqueProtocolIds() {
    val values = AforaCapability.entries.map { it.rawValue }

    assertTrue(values.isNotEmpty())
    assertTrue(values.all { it.isNotBlank() && "." !in it })
    assertTrue(values.size == values.toSet().size)
  }

  @Test
  fun generatedCommandGroupsMatchTheirNamespaces() {
    val groups =
      listOf(
        AforaCanvasCommand.NamespacePrefix to AforaCanvasCommand.entries.map { it.rawValue },
        AforaCanvasA2UICommand.NamespacePrefix to AforaCanvasA2UICommand.entries.map { it.rawValue },
        AforaCameraCommand.NamespacePrefix to AforaCameraCommand.entries.map { it.rawValue },
        AforaSmsCommand.NamespacePrefix to AforaSmsCommand.entries.map { it.rawValue },
        AforaTalkCommand.NamespacePrefix to AforaTalkCommand.entries.map { it.rawValue },
        AforaLocationCommand.NamespacePrefix to AforaLocationCommand.entries.map { it.rawValue },
        AforaDeviceCommand.NamespacePrefix to AforaDeviceCommand.entries.map { it.rawValue },
        AforaNotificationsCommand.NamespacePrefix to AforaNotificationsCommand.entries.map { it.rawValue },
        AforaSystemCommand.NamespacePrefix to AforaSystemCommand.entries.map { it.rawValue },
        AforaPhotosCommand.NamespacePrefix to AforaPhotosCommand.entries.map { it.rawValue },
        AforaContactsCommand.NamespacePrefix to AforaContactsCommand.entries.map { it.rawValue },
        AforaCalendarCommand.NamespacePrefix to AforaCalendarCommand.entries.map { it.rawValue },
        AforaMotionCommand.NamespacePrefix to AforaMotionCommand.entries.map { it.rawValue },
        AforaCallLogCommand.NamespacePrefix to AforaCallLogCommand.entries.map { it.rawValue },
      )

    val commands = groups.flatMap { (prefix, values) -> values.onEach { assertTrue(it.startsWith(prefix)) } }
    assertTrue(commands.size == commands.toSet().size)
  }
}
