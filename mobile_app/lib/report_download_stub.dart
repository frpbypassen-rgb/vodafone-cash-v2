import 'external_link.dart';

Object? prepareReportDownload() => null;

Future<bool> openPreparedReportDownload(Object? _, Uri uri) {
  return openExternalLink(uri);
}

void cancelPreparedReportDownload(Object? _) {}
