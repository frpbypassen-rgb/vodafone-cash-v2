import 'package:flutter/services.dart';

const _externalLinkChannel = MethodChannel(
  'com.ahrampay.mobile_app/external_link',
);

Future<bool> openExternalLink(Uri uri) async {
  try {
    return await _externalLinkChannel.invokeMethod<bool>('open', <String, String>{
          'url': uri.toString(),
        }) ??
        false;
  } on PlatformException {
    return false;
  }
}
