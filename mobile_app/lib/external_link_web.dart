// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use

import 'dart:html' as html;

Future<bool> openExternalUrl(String url) async {
  final value = url.trim();
  if (value.isEmpty) return false;
  try {
    if (value.toLowerCase().startsWith('tel:')) {
      html.window.location.href = value;
      return true;
    }
    html.window.open(value, '_blank');
    return true;
  } catch (_) {
    return false;
  }
}

Future<bool> openExternalLink(Uri uri) => openExternalUrl(uri.toString());
