// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use

import 'dart:html' as html;

Future<bool> openExternalLink(Uri uri) async {
  html.window.open(uri.toString(), '_blank');
  return true;
}
