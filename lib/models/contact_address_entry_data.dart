/* 
 * This file is part of Stack Wallet.
 * 
 * Copyright (c) 2023 Cypher Stack
 * All Rights Reserved.
 * The code is distributed under GPLv3 license, see LICENSE file for details.
 * Generated by Cypher Stack on 2023-05-26
 *
 */

import 'package:flutter/cupertino.dart';
import 'isar/models/contact_entry.dart';
import '../wallets/crypto_currency/crypto_currency.dart';

class AddressEntryData extends ChangeNotifier {
  late int id;

  AddressEntryData(this.id);

  String? _addressLabel;
  String? _address;
  CryptoCurrency? _coin;

  String? get addressLabel => _addressLabel;

  set addressLabel(String? addressLabel) {
    _addressLabel = addressLabel;
    notifyListeners();
  }

  String? get address => _address;

  set address(String? address) {
    _address = address;
    notifyListeners();
  }

  CryptoCurrency? get coin => _coin;

  set coin(CryptoCurrency? coin) {
    _coin = coin;
    notifyListeners();
  }

  bool get isEmpty {
    if (address != null && address!.isNotEmpty) {
      return false;
    }
    if (addressLabel != null && addressLabel!.isNotEmpty) {
      return false;
    }
    if (coin != null) {
      return false;
    }
    return true;
  }

  bool get isValid {
    if (_address == null || coin == null || _addressLabel == null) {
      return false;
    }
    if (_address!.isEmpty || _addressLabel!.isEmpty) {
      return false;
    }
    return isValidAddress;
  }

  bool get isValidAddress {
    if (coin == null) {
      return true;
    }
    if (_address == null) {
      return false;
    }
    return _coin!.validateAddress(_address!);
  }

  ContactAddressEntry buildAddressEntry() {
    return ContactAddressEntry()
      ..coinName = coin!.identifier
      ..address = address!
      ..other = null
      ..label = addressLabel!;
  }

  @override
  String toString() {
    return "AddressEntryData: { addressLabel: $addressLabel, address: $address, coin: ${coin?.identifier} }";
  }
}
