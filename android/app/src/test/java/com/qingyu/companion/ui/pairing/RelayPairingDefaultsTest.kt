package com.qingyu.companion.ui.pairing

import com.qingyu.companion.network.relay.RelayUrlPolicy
import org.junit.Assert.assertEquals
import org.junit.Test

class RelayPairingDefaultsTest {
    @Test
    fun serverConnectionUsesOfficialRelayByDefault() {
        assertEquals(RelayUrlPolicy.DEFAULT_BASE_URL, RelayPairingViewModel.UiState().baseUrl)
    }
}
