// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use

import 'dart:html' as html;

Object? prepareReportDownload() => html.window.open('', '_blank');

Future<bool> openPreparedReportDownload(Object? target, Uri uri) async {
  if (target is html.WindowBase) {
    target.location.href = uri.toString();
    return true;
  }
  html.window.open(uri.toString(), '_blank');
  return true;
}

void cancelPreparedReportDownload(Object? target) {
  if (target is html.WindowBase) target.close();
}
