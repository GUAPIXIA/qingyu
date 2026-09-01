package com.qingyu.companion.model

import com.qingyu.companion.network.NetworkModule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RelayConnectionCompatTest {
    @Test fun oldJsonDefaultsToLan() {
        val old = """{"name":"PC","host":"192.168.1.2","port":8321,"token":"t","deviceId":"d","fingerprint":"f"}"""
        val connection = NetworkModule.json.decodeFromString(ServerConnection.serializer(), old)
        assertEquals(ConnectionMode.LAN, connection.mode)
        assertNull(connection.relay)
    }
}
