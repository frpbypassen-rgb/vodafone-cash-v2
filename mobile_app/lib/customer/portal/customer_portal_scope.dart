import 'package:flutter/material.dart';

/// Lets customer portal pages push content into the desktop inspector panel.
class CustomerPortalScope extends InheritedWidget {
  const CustomerPortalScope({
    super.key,
    required this.setInspector,
    required super.child,
  });

  final void Function(Widget? panel, {String? title}) setInspector;

  static CustomerPortalScope? maybeOf(BuildContext context) {
    return context.dependOnInheritedWidgetOfExactType<CustomerPortalScope>();
  }

  @override
  bool updateShouldNotify(CustomerPortalScope oldWidget) => false;
}
