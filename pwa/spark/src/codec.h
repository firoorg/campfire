// SPDX-License-Identifier: MIT
// Campfire PWA Spark module: the byte codec between JS and the wasm exports.
//
// Every export takes one request buffer and returns one result buffer. Both are
// sequences of these fields, little endian, no padding:
//   u8, u32, i32, u64, i64          fixed-width integers
//   bytes / str                     u32 length, then that many bytes (str = UTF-8)
//   fixed(N)                        exactly N bytes, no length
// The JS side is pwa/src/lib/firo/spark/codec.js; field order per export is
// documented in spark_wasm.cpp. A request with missing or trailing bytes is
// refused, so the two sides cannot silently drift apart.
#ifndef CAMPFIRE_SPARK_CODEC_H
#define CAMPFIRE_SPARK_CODEC_H

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace campfire_spark {

class Reader {
public:
    Reader(const uint8_t* data, size_t size) : p_(data), n_(size) {}

    uint8_t u8() { need(1); return p_[off_++]; }
    uint32_t u32()
    {
        need(4);
        uint32_t v = 0;
        for (int i = 0; i < 4; i++) v |= uint32_t(p_[off_ + i]) << (8 * i);
        off_ += 4;
        return v;
    }
    int32_t i32() { return static_cast<int32_t>(u32()); }
    uint64_t u64()
    {
        need(8);
        uint64_t v = 0;
        for (int i = 0; i < 8; i++) v |= uint64_t(p_[off_ + i]) << (8 * i);
        off_ += 8;
        return v;
    }
    int64_t i64() { return static_cast<int64_t>(u64()); }
    bool flag()
    {
        const uint8_t v = u8();
        if (v > 1) throw std::invalid_argument("request: a flag must be 0 or 1");
        return v == 1;
    }

    // A view into the request; valid while the request buffer lives.
    struct View {
        const uint8_t* data;
        size_t size;
        std::vector<unsigned char> vec() const { return std::vector<unsigned char>(data, data + size); }
        std::string str() const { return std::string(reinterpret_cast<const char*>(data), size); }
    };

    View bytes()
    {
        const uint32_t len = u32();
        need(len);
        View v{p_ + off_, len};
        off_ += len;
        return v;
    }
    std::string str() { return bytes().str(); }
    View fixed(size_t len)
    {
        need(len);
        View v{p_ + off_, len};
        off_ += len;
        return v;
    }
    // A count of items, each at least min_item_size bytes: refuses counts the
    // remaining request cannot hold, before anything is allocated for them.
    uint32_t count(size_t min_item_size)
    {
        const uint32_t c = u32();
        if (min_item_size > 0 && c > (n_ - off_) / min_item_size)
            throw std::invalid_argument("request: item count larger than the request");
        return c;
    }
    void end() const
    {
        if (off_ != n_) throw std::invalid_argument("request: unexpected trailing bytes");
    }

private:
    void need(size_t k) const
    {
        if (k > n_ - off_) throw std::invalid_argument("request: truncated");
    }
    const uint8_t* p_;
    size_t n_;
    size_t off_ = 0;
};

class Writer {
public:
    void u8(uint8_t v) { b_.push_back(v); }
    void u32(uint32_t v) { for (int i = 0; i < 4; i++) b_.push_back(uint8_t(v >> (8 * i))); }
    void i32(int32_t v) { u32(static_cast<uint32_t>(v)); }
    void u64(uint64_t v) { for (int i = 0; i < 8; i++) b_.push_back(uint8_t(v >> (8 * i))); }
    void i64(int64_t v) { u64(static_cast<uint64_t>(v)); }
    void raw(const void* p, size_t n)
    {
        const uint8_t* q = static_cast<const uint8_t*>(p);
        b_.insert(b_.end(), q, q + n);
    }
    void bytes(const void* p, size_t n)
    {
        if (n > 0xffffffffu) throw std::length_error("result field too large");
        u32(static_cast<uint32_t>(n));
        raw(p, n);
    }
    template <typename C>
    void bytes(const C& c) { bytes(c.data(), c.size()); }
    void str(const std::string& s) { bytes(s.data(), s.size()); }
    std::vector<uint8_t>& buffer() { return b_; }

private:
    std::vector<uint8_t> b_;
};

} // namespace campfire_spark

#endif
