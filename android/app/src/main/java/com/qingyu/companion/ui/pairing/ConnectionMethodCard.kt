package com.qingyu.companion.ui.pairing

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.qingyu.companion.ui.theme.qyColors

@Composable
fun ConnectionMethodCard(title: String, description: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val qy = qyColors()
    Surface(
        modifier = modifier.clickable(onClick = onClick),
        shape = RoundedCornerShape(16.dp),
        color = if (selected) qy.accentSoft else qy.card,
        tonalElevation = if (selected) 2.dp else 0.dp,
    ) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = if (selected) qy.accent else qy.text)
            Text(description, style = MaterialTheme.typography.bodySmall, color = qy.soft)
        }
    }
}
