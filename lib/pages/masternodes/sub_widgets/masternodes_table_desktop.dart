import 'package:flutter/material.dart';

import '../../../themes/stack_colors.dart';
import '../../../utilities/text_styles.dart';
import '../../../wallets/wallet/impl/firo_wallet.dart';
import '../../../widgets/dialogs/s_dialog.dart';
import 'masternode_info_widget.dart';

class MasternodesTableDesktop extends StatelessWidget {
  const MasternodesTableDesktop({super.key, required this.nodes});

  final List<MasternodeInfo> nodes;

  @override
  Widget build(BuildContext context) {
    final stack = Theme.of(context).extension<StackColors>()!;
    return Container(
      color: stack.textFieldDefaultBG,
      child: Column(
        children: [
          // Fixed header
          Container(
            height: 56,
            color: stack.textFieldDefaultBG,
            child: Row(
              children: [
                const Expanded(
                  flex: 2,
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: Padding(
                      padding: EdgeInsets.symmetric(horizontal: 16),
                      child: Text('IP'),
                    ),
                  ),
                ),
                const Expanded(
                  flex: 2,
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: Padding(
                      padding: EdgeInsets.symmetric(horizontal: 16),
                      child: Text('Last Paid Height'),
                    ),
                  ),
                ),
                const Expanded(
                  flex: 2,
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: Padding(
                      padding: EdgeInsets.symmetric(horizontal: 16),
                      child: Text('Status'),
                    ),
                  ),
                ),
                Expanded(flex: 3, child: Container()),
              ],
            ),
          ),
          // Scrollable content
          Expanded(
            child: Container(
              width: double.infinity,
              color: stack.textFieldDefaultBG,
              child: SingleChildScrollView(
                scrollDirection: Axis.vertical,
                child: Column(
                  children: nodes.map((node) {
                    final status = node.revocationReason == 0
                        ? 'Active'
                        : 'Revoked';
                    return SizedBox(
                      height: 48,
                      child: Row(
                        children: [
                          Expanded(
                            flex: 2,
                            child: Align(
                              alignment: Alignment.centerRight,
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 16,
                                ),
                                child: Text(
                                  node.serviceAddr,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            ),
                          ),
                          Expanded(
                            flex: 2,
                            child: Align(
                              alignment: Alignment.centerRight,
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 16,
                                ),
                                child: Text(
                                  node.lastPaidHeight.toString(),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            ),
                          ),
                          Expanded(
                            flex: 2,
                            child: Align(
                              alignment: Alignment.centerRight,
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 16,
                                ),
                                child: Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 8,
                                    vertical: 4,
                                  ),
                                  decoration: BoxDecoration(
                                    color: status.toLowerCase() == 'active'
                                        ? stack.accentColorGreen
                                        : stack.accentColorRed,
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                  child: Text(
                                    status.toUpperCase(),
                                    style: STextStyles.w600_12(
                                      context,
                                    ).copyWith(color: stack.textWhite),
                                  ),
                                ),
                              ),
                            ),
                          ),
                          Expanded(
                            flex: 3,
                            child: Align(
                              alignment: Alignment.centerRight,
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 16,
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    IconButton(
                                      onPressed: () {
                                        showDialog<void>(
                                          context: context,
                                          barrierDismissible: true,
                                          builder: (context) => SDialog(
                                            child: SizedBox(
                                              width: 600,
                                              child: MasternodeInfoWidget(
                                                info: node,
                                              ),
                                            ),
                                          ),
                                        );
                                      },
                                      icon: const Icon(Icons.info_outline),
                                      tooltip: 'View Details',
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    );
                  }).toList(),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
