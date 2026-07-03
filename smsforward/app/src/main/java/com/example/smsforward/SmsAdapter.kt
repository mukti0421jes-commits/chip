package com.example.smsforward

import android.text.format.DateFormat
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.example.smsforward.databinding.ItemSmsBinding

class SmsAdapter(
    private val onCodeClick: (String) -> Unit
) : RecyclerView.Adapter<SmsAdapter.VH>() {

    private val items = ArrayList<SmsItem>()

    fun submit(newItems: List<SmsItem>) {
        items.clear()
        items.addAll(newItems)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val b = ItemSmsBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return VH(b)
    }

    override fun getItemCount() = items.size

    override fun onBindViewHolder(holder: VH, position: Int) = holder.bind(items[position])

    inner class VH(private val b: ItemSmsBinding) : RecyclerView.ViewHolder(b.root) {
        fun bind(item: SmsItem) {
            b.sender.text = b.root.context.getString(R.string.from_label, item.sender)
            b.body.text = item.body
            b.time.text = DateFormat.format("dd MMM, hh:mm:ss a", item.time)

            if (item.otp != null) {
                b.otpBadge.visibility = View.VISIBLE
                b.otpBadge.text = item.otp
                b.otpBadge.setOnClickListener { onCodeClick(item.otp) }
            } else {
                b.otpBadge.visibility = View.GONE
                b.otpBadge.setOnClickListener(null)
            }
        }
    }
}
