// SPDX-License-Identifier: MIT
// Campfire PWA: the one Boost feature sparkmobile uses, without Boost.
//
// sparkmobile a9d0789 includes <boost/optional.hpp> only in src/primitives.h for
//     mutable boost::optional<uint256> nonceHash;   // a memo of GetNonceHash(k)
// and uses it only as (src/primitives.cpp:6-8):
//     if (!nonceHash) nonceHash.reset(primitives::GetNonceHash(k));
//     return *nonceHash;
// std::optional covers that except reset(value), which Boost defines as
// "assign value". Anything else fails to compile, which is the point.
#ifndef CAMPFIRE_SPARK_SHIM_BOOST_OPTIONAL_HPP
#define CAMPFIRE_SPARK_SHIM_BOOST_OPTIONAL_HPP

#include <optional>
#include <utility>

namespace boost {

template <typename T>
class optional : public std::optional<T> {
public:
    using std::optional<T>::optional;
    using std::optional<T>::operator=;
    using std::optional<T>::operator*;
    using std::optional<T>::operator->;

    void reset() noexcept { std::optional<T>::reset(); }
    void reset(const T& value) { this->emplace(value); }
};

} // namespace boost

#endif
