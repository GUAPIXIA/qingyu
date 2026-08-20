package com.qingyu.companion.data

import kotlinx.serialization.SerializationException
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response
import java.net.SocketTimeoutException
import java.net.UnknownHostException

class CompanionErrorTest {

    private fun httpException(code: Int, msg: String = "error"): HttpException {
        val response = Response.error<Any>(code, msg.toResponseBody())
        return HttpException(response)
    }

    @Test fun `401 maps to Unauthorized`() {
        val err = httpException(401).toCompanionError()
        assertTrue(err is CompanionError.Unauthorized)
        assertTrue(err.userMessage().contains("重新配对"))
    }

    @Test fun `426 maps to IncompatibleVersion`() {
        val err = httpException(426).toCompanionError()
        assertTrue(err is CompanionError.IncompatibleVersion)
        assertTrue(err.userMessage().contains("升级"))
    }

    @Test fun `500 maps to ServerRejected`() {
        val err = httpException(500).toCompanionError()
        assertTrue(err is CompanionError.ServerRejected)
        assertEquals(500, (err as CompanionError.ServerRejected).code)
    }

    @Test fun `UnknownHost maps to Offline`() {
        val err = UnknownHostException("Unable to resolve host").toCompanionError()
        assertTrue(err is CompanionError.Offline)
    }

    @Test fun `SocketTimeout maps to Timeout`() {
        val err = SocketTimeoutException("timeout").toCompanionError()
        assertTrue(err is CompanionError.Timeout)
        assertTrue(err.isRetryable())
    }

    @Test fun `SerializationException maps to ParseError`() {
        val err = SerializationException("bad json").toCompanionError()
        assertTrue(err is CompanionError.ParseError)
    }

    @Test fun `Offline isRetryable`() {
        assertTrue(CompanionError.Offline().isRetryable())
        assertTrue(CompanionError.Timeout().isRetryable())
        assertFalse(CompanionError.Unauthorized().isRetryable())
        assertFalse(CompanionError.IncompatibleVersion().isRetryable())
    }

    @Test fun `ServerRejected 5xx isRetryable`() {
        assertTrue(CompanionError.ServerRejected(500, "err").isRetryable())
        assertFalse(CompanionError.ServerRejected(400, "bad").isRetryable())
    }
}
