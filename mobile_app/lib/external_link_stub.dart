import 'package:flutter/services.dart';

const _externalLinkChannel = MethodChannel(
  'com.ahrampay.mobile_app/external_link',
);

Future<bool> openExternalUrl(String url) async {
  final value = url.trim();
  if (value.isEmpty) return false;
  try {
    return await _externalLinkChannel.invokeMethod<bool>('open', <String, String>{
          'url': value,
        }) ??
        false;
  } on PlatformException {
    return false;
  }
}

Future<bool> openExternalLink(Uri uri) => openExternalUrl(uri.toString());
