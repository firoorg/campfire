import 'package:flutter/material.dart';

import '../../../themes/stack_colors.dart';
import '../../../utilities/text_styles.dart';
import '../../../wallets/wallet/impl/firo_wallet.dart';
import '../../../widgets/rounded_white_container.dart';
import '../masternode_details_view.dart';

class MasternodesList extends StatelessWidget {
  const MasternodesList({super.key, required this.nodes});

  final List<MasternodeInfo> nodes;

  @override
  Widget build(BuildContext context) {
    return ListView.separated(
      padding: EdgeInsets.zero,
      itemCount: nodes.length,
      separatorBuilder: (_, __) => const SizedBox(height: 8),
      itemBuilder: (context, index) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: _MasternodeCard(node: nodes[index]),
      ),
    );
  }
}

// TODO better styling
class _MasternodeCard extends StatelessWidget {
  const _MasternodeCard({super.key, required this.node});

  final MasternodeInfo node;

  @override
  Widget build(BuildContext context) {
    final stack = Theme.of(context).extension<StackColors>()!;
    return RoundedWhiteContainer(
      onPressed: () => Navigator.of(
        context,
      ).pushNamed(MasternodeDetailsView.routeName, arguments: node),
      child: Column(
        mainAxisSize: .min,
        children: [
          Row(
            mainAxisAlignment: .spaceBetween,
            children: [
              Text("IP: ${node.serviceAddr}"),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: node.revocationReason == 0
                      ? stack.accentColorGreen
                      : stack.accentColorRed,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  node.revocationReason == 0 ? "ACTIVE" : "REVOKED",
                  style: STextStyles.w600_12(
                    context,
                  ).copyWith(color: stack.textWhite),
                ),
              ),
            ],
          ),
          Row(
            mainAxisAlignment: .spaceBetween,
            children: [Text("Last Paid Height: ${node.lastPaidHeight}")],
          ),
        ],
      ),
    );
  }
}
