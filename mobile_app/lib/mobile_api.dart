import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:geolocator/geolocator.dart';
import 'package:uuid/uuid.dart';

import 'workspace/workspace_kind.dart';

class ApiFailure implements Exception {
  const ApiFailure(this.message, {this.statusCode, this.code, this.data});

  final String message;
  final int? statusCode;
  final String? code;
  final Map<String, dynamic>? data;

  @override
  String toString() => message;
}

class MobileSession {
  const MobileSession({
    required this.token,
    required this.refreshToken,
    required this.id,
    required this.accountType,
    required this.persona,
    required this.name,
    required this.balance,
    required this.tier,
    required this.exchangeRate,
    required this.baseExchangeRate,
    required this.serviceRates,
    required this.serviceCatalog,
    required this.isOpen,
    required this.context,
    this.role,
    this.permissions = const [],
    this.creditLimit,
    this.debt,
    this.availableToSpend,
  });

  final String token;
  final String refreshToken;
  final String id;
  final String accountType;
  final String persona;
  final String name;
  final double balance;
  final int tier;
  final double exchangeRate;
  final double baseExchangeRate;
  final Map<String, dynamic> serviceRates;
  final List<Map<String, dynamic>> serviceCatalog;
  final bool isOpen;
  final Map<String, dynamic> context;
  final String? role;
  final List<String> permissions;
  final double? creditLimit;
  final double? debt;
  final double? availableToSpend;

  static double _number(dynamic value, [double fallback = 0]) {
    if (value is num) return value.toDouble();
    return double.tryParse('$value') ?? fallback;
  }

  static int _integer(dynamic value, [int fallback = 1]) {
    if (value is num) return value.toInt();
    return int.tryParse('$value') ?? fallback;
  }

  static Map<String, dynamic> _map(dynamic value) {
    if (value is Map) return Map<String, dynamic>.from(value);
    return <String, dynamic>{};
  }

  static List<Map<String, dynamic>> _mapList(dynamic value) {
    if (value is! List) return <Map<String, dynamic>>[];
    return value.whereType<Map>().map((item) => _map(item)).toList();
  }

  factory MobileSession.fromJson(Map<String, dynamic> json) {
    return MobileSession(
      token: '${json['token'] ?? ''}',
      refreshToken: '${json['refreshToken'] ?? ''}',
      id: '${json['id'] ?? ''}',
      accountType: '${json['accountType'] ?? 'client_user'}',
      persona: '${json['persona'] ?? 'directClient'}',
      name: '${json['name'] ?? 'مستخدم'}',
      balance: _number(json['balance']),
      tier: _integer(json['tier']),
      exchangeRate: _number(json['exchangeRate'], 1),
      baseExchangeRate: _number(json['baseExchangeRate'], 1),
      serviceRates: _map(json['serviceRates']),
      serviceCatalog: _mapList(json['serviceCatalog']),
      isOpen: json['isOpen'] != false,
      context: _map(json['context']),
      role: json['role']?.toString(),
      permissions: (json['permissions'] as List? ?? const [])
          .map((item) => '$item')
          .toList(),
      creditLimit: json['creditLimit'] == null
          ? null
          : _number(json['creditLimit']),
      debt: json['debt'] == null ? null : _number(json['debt']),
      availableToSpend: json['availableToSpend'] == null
          ? null
          : _number(json['availableToSpend']),
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
    'token': token,
    'refreshToken': refreshToken,
    'id': id,
    'accountType': accountType,
    'persona': persona,
    'name': name,
    'balance': balance,
    'tier': tier,
    'exchangeRate': exchangeRate,
    'baseExchangeRate': baseExchangeRate,
    'serviceRates': serviceRates,
    'serviceCatalog': serviceCatalog,
    'isOpen': isOpen,
    'context': context,
    'role': role,
    'permissions': permissions,
    'creditLimit': creditLimit,
    'debt': debt,
    'availableToSpend': availableToSpend,
  };

  MobileSession copyWith({
    String? token,
    String? refreshToken,
    String? name,
    double? balance,
    int? tier,
    double? exchangeRate,
    double? baseExchangeRate,
    Map<String, dynamic>? serviceRates,
    List<Map<String, dynamic>>? serviceCatalog,
    Map<String, dynamic>? context,
    bool? isOpen,
    double? creditLimit,
    double? debt,
    double? availableToSpend,
  }) {
    return MobileSession(
      token: token ?? this.token,
      refreshToken: refreshToken ?? this.refreshToken,
      id: id,
      accountType: accountType,
      persona: persona,
      name: name ?? this.name,
      balance: balance ?? this.balance,
      tier: tier ?? this.tier,
      exchangeRate: exchangeRate ?? this.exchangeRate,
      baseExchangeRate: baseExchangeRate ?? this.baseExchangeRate,
      serviceRates: serviceRates ?? this.serviceRates,
      serviceCatalog: serviceCatalog ?? this.serviceCatalog,
      isOpen: isOpen ?? this.isOpen,
      context: context ?? this.context,
      role: role,
      permissions: permissions,
      creditLimit: creditLimit ?? this.creditLimit,
      debt: debt ?? this.debt,
      availableToSpend: availableToSpend ?? this.availableToSpend,
    );
  }

  MobileSession applyHome(Map<String, dynamic> home) {
    return copyWith(
      balance: home.containsKey('balance') ? _number(home['balance']) : balance,
      tier: home.containsKey('tier') ? _integer(home['tier']) : tier,
      exchangeRate: home.containsKey('exchangeRate')
          ? _number(home['exchangeRate'], exchangeRate)
          : exchangeRate,
      baseExchangeRate: home.containsKey('baseExchangeRate')
          ? _number(home['baseExchangeRate'], baseExchangeRate)
          : baseExchangeRate,
      serviceRates: home.containsKey('serviceRates')
          ? _map(home['serviceRates'])
          : serviceRates,
      serviceCatalog: home.containsKey('serviceCatalog')
          ? _mapList(home['serviceCatalog'])
          : serviceCatalog,
      isOpen: home.containsKey('isOpen') ? home['isOpen'] != false : isOpen,
      creditLimit: home.containsKey('creditLimit')
          ? _number(home['creditLimit'])
          : creditLimit,
      debt: home.containsKey('debt') ? _number(home['debt']) : debt,
      availableToSpend: home.containsKey('availableToSpend')
          ? _number(home['availableToSpend'])
          : availableToSpend,
      context: home.containsKey('context') ? _map(home['context']) : context,
    );
  }
}

class SessionStore {
  static const _sessionKey = 'power_pay_mobile_session_v1';
  static const _savedLoginKey = 'power_pay_mobile_saved_login_v1';
  static const _customerNotificationsKey =
      'power_pay_mobile_customer_notifications_v1';
  static const _pushInstallationIdKey = 'ahram_pay_push_installation_id_v1';
  static const _pendingPushInteractionKey =
      'ahram_pay_pending_push_interaction_v1';
  static const _deviceIdKey = 'ahram_pay_mfa_device_id_v1';
  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  Future<MobileSession?> read() async {
    final raw = await _storage.read(key: _sessionKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) {
        final session = MobileSession.fromJson(
          Map<String, dynamic>.from(decoded),
        );
        return session.token.isEmpty || session.refreshToken.isEmpty
            ? null
            : session;
      }
    } catch (_) {
      await clear();
    }
    return null;
  }

  Future<void> write(MobileSession session) {
    return _storage.write(
      key: _sessionKey,
      value: jsonEncode(session.toJson()),
    );
  }

  Future<void> clear() => _storage.delete(key: _sessionKey);

  Future<SavedLoginCredentials?> readSavedLogin() async {
    final raw = await _storage.read(key: _savedLoginKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) {
        final username = '${decoded['username'] ?? ''}'.trim();
        final password = '${decoded['password'] ?? ''}';
        if (username.isNotEmpty && password.isNotEmpty) {
          return SavedLoginCredentials(username: username, password: password);
        }
      }
    } catch (_) {
      await clearSavedLogin();
    }
    return null;
  }

  Future<void> saveLogin({required String username, required String password}) {
    return _storage.write(
      key: _savedLoginKey,
      value: jsonEncode(<String, String>{
        'username': username.trim(),
        'password': password,
      }),
    );
  }

  Future<void> clearSavedLogin() => _storage.delete(key: _savedLoginKey);

  Future<String> readOrCreateDeviceId() async {
    final existing = await _storage.read(key: _deviceIdKey);
    if (existing != null && existing.trim().isNotEmpty) return existing.trim();
    final id = const Uuid().v4();
    await _storage.write(key: _deviceIdKey, value: id);
    return id;
  }

  Future<bool> readCustomerNotificationsEnabled() async {
    final raw = await _storage.read(key: _customerNotificationsKey);
    return raw != 'false';
  }

  Future<void> setCustomerNotificationsEnabled(bool enabled) {
    return _storage.write(
      key: _customerNotificationsKey,
      value: enabled ? 'true' : 'false',
    );
  }

  Future<String> readOrCreatePushInstallationId() async {
    final existing = await _storage.read(key: _pushInstallationIdKey);
    if (existing != null && existing.trim().isNotEmpty) return existing.trim();
    final installationId = const Uuid().v4();
    await _storage.write(key: _pushInstallationIdKey, value: installationId);
    return installationId;
  }

  Future<void> writePendingPushInteraction(String value) =>
      _storage.write(key: _pendingPushInteractionKey, value: value);

  Future<String?> takePendingPushInteraction() async {
    final value = await _storage.read(key: _pendingPushInteractionKey);
    await _storage.delete(key: _pendingPushInteractionKey);
    return value;
  }
}

class SavedLoginCredentials {
  const SavedLoginCredentials({required this.username, required this.password});

  final String username;
  final String password;
}

class MobileApi {
  MobileApi(this._store)
    : _dio = Dio(
        BaseOptions(
          baseUrl: const String.fromEnvironment(
            'API_BASE_URL',
            defaultValue: 'https://ahrampay.com/api/mobile',
          ),
          connectTimeout: const Duration(seconds: 20),
          receiveTimeout: const Duration(seconds: 30),
          sendTimeout: const Duration(seconds: 30),
          headers: const <String, dynamic>{
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-Client-Platform': 'app',
            'X-Client-Channel': 'app',
          },
        ),
      );

  final SessionStore _store;
  final Dio _dio;
  final Uuid _uuid = const Uuid();
  Future<bool>? _refreshing;

  String get baseUrl => _dio.options.baseUrl;

  Uri resolveMediaUrl(String rawUrl) {
    final value = rawUrl.trim();
    final parsed = Uri.tryParse(value);
    if (parsed != null && parsed.hasScheme) return parsed;
    return Uri.parse(
      baseUrl,
    ).resolve(value.startsWith('/') ? value : '/$value');
  }

  Future<MobileSession> login({
    required String username,
    required String password,
    String? mfaToken,
    bool trustDevice = true,
  }) async {
    final deviceId = await _store.readOrCreateDeviceId();
    Position? securityPosition;
    try {
      if (await Geolocator.isLocationServiceEnabled()) {
        var permission = await Geolocator.checkPermission();
        if (permission == LocationPermission.denied) {
          permission = await Geolocator.requestPermission();
        }
        if (permission == LocationPermission.always ||
            permission == LocationPermission.whileInUse) {
          securityPosition = await Geolocator.getCurrentPosition(
            locationSettings: const LocationSettings(
              accuracy: LocationAccuracy.high,
              timeLimit: Duration(seconds: 10),
            ),
          );
        }
      }
    } catch (_) {
      // The server decides whether location is mandatory for this account.
    }
    final response = await _request(
      'POST',
      '/login',
      data: <String, dynamic>{
        'username': username,
        'password': password,
        if (mfaToken != null && mfaToken.trim().isNotEmpty)
          'mfaToken': mfaToken.trim(),
        'trustDevice': trustDevice,
        if (securityPosition != null) ...<String, dynamic>{
          'latitude': securityPosition.latitude,
          'longitude': securityPosition.longitude,
          'locationAccuracy': securityPosition.accuracy,
        },
      },
      authenticated: false,
      extraHeaders: <String, dynamic>{'X-Device-Id': deviceId},
    );
    final session = MobileSession.fromJson(response);
    if (session.token.isEmpty || session.refreshToken.isEmpty) {
      throw const ApiFailure('تعذر إنشاء جلسة الدخول، يرجى المحاولة لاحقاً.');
    }
    return session;
  }

  Future<Map<String, dynamic>> lookupRegistrationAgent(String code) {
    return _request(
      'GET',
      '/client/register/agent-lookup',
      query: <String, dynamic>{'code': code},
      authenticated: false,
    );
  }

  Future<Map<String, dynamic>> registerDirectAccount({
    required String fullName,
    required String phone,
    required String storeName,
    required String address,
    required String username,
    required String password,
  }) {
    return _request(
      'POST',
      '/client/register/direct',
      authenticated: false,
      data: <String, dynamic>{
        'fullName': fullName,
        'phone': phone,
        'storeName': storeName,
        'address': address,
        'username': username,
        'password': password,
      },
    );
  }

  Future<Map<String, dynamic>> registerCompanyAccount({
    required String companyName,
    required String companyContact,
    required String companyPhone,
    required String companyEmail,
    required String username,
    required String password,
  }) {
    return _request(
      'POST',
      '/client/register/company',
      authenticated: false,
      data: <String, dynamic>{
        'companyName': companyName,
        'companyContact': companyContact,
        'companyPhone': companyPhone,
        'companyEmail': companyEmail,
        'username': username,
        'password': password,
      },
    );
  }

  Future<Map<String, dynamic>> registerAgentAccount({
    required String companyName,
    required String fullName,
    required String phone,
    required String address,
    required String city,
    required String companyEmail,
    required String username,
    required String password,
  }) {
    return _request(
      'POST',
      '/client/register/agent',
      authenticated: false,
      data: <String, dynamic>{
        'companyName': companyName,
        'fullName': fullName,
        'phone': phone,
        'address': address,
        'city': city,
        'companyEmail': companyEmail,
        'username': username,
        'password': password,
      },
    );
  }

  Future<Map<String, dynamic>> registerNewClientAccount({
    required String fullName,
    required String phone,
    required String city,
    required String nationality,
    required String username,
    required String password,
    required String agentCode,
  }) {
    return _request(
      'POST',
      '/client/register/new',
      authenticated: false,
      data: <String, dynamic>{
        'fullName': fullName,
        'phone': phone,
        'city': city,
        'nationality': nationality,
        'username': username,
        'password': password,
        'agentCode': agentCode,
      },
    );
  }

  Future<void> logout() async {
    try {
      await _request('POST', '/logout');
    } catch (_) {
      // Local session removal must still succeed when the device is offline.
    }
  }

  Future<Map<String, dynamic>> registerPushDevice({
    required String installationId,
    required String token,
    required String platform,
    required String permissionStatus,
    String appVersion = '',
    String deviceName = '',
    String locale = '',
    String timeZone = '',
  }) {
    return _request(
      'POST',
      '/push/devices/register',
      data: <String, dynamic>{
        'installationId': installationId,
        'token': token,
        'platform': platform,
        'permissionStatus': permissionStatus,
        'appVersion': appVersion,
        'deviceName': deviceName,
        'locale': locale,
        'timeZone': timeZone,
      },
    );
  }

  Future<void> unregisterPushDevice(String installationId) async {
    await _request(
      'POST',
      '/push/devices/unregister',
      data: <String, dynamic>{'installationId': installationId},
    );
  }

  Future<Map<String, dynamic>> pushDeviceStatus(String installationId) {
    return _request(
      'GET',
      '/push/devices/status',
      query: <String, dynamic>{'installationId': installationId},
    );
  }

  Future<Map<String, dynamic>> testPushDevice(
    String installationId, {
    String category = 'executor_task_new',
  }) {
    return _request(
      'POST',
      '/push/devices/test',
      data: <String, dynamic>{
        'installationId': installationId,
        'category': category,
      },
    );
  }

  Future<void> acknowledgePushTask({
    required String installationId,
    required String transactionId,
  }) async {
    await _request(
      'POST',
      '/push/tasks/$transactionId/ack',
      data: <String, dynamic>{'installationId': installationId},
    );
  }

  Future<Map<String, dynamic>> snoozePushTask({
    required String installationId,
    required String transactionId,
    int minutes = 5,
  }) {
    return _request(
      'POST',
      '/push/tasks/$transactionId/snooze',
      data: <String, dynamic>{
        'installationId': installationId,
        'minutes': minutes,
      },
    );
  }

  Future<Map<String, dynamic>> pushPreferences(String installationId) {
    return _request(
      'GET',
      '/push/preferences',
      query: <String, dynamic>{'installationId': installationId},
    );
  }

  Future<Map<String, dynamic>> updatePushPreferences({
    required String installationId,
    required Map<String, bool> preferences,
  }) {
    return _request(
      'PATCH',
      '/push/preferences',
      data: <String, dynamic>{
        'installationId': installationId,
        'preferences': preferences,
      },
    );
  }

  Future<Map<String, dynamic>> pushInbox({
    String? category,
    bool unreadOnly = false,
    int page = 1,
    int limit = 30,
  }) {
    return _request(
      'GET',
      '/push/inbox',
      query: <String, dynamic>{
        if (category != null && category.isNotEmpty) 'category': category,
        'unreadOnly': unreadOnly,
        'page': page,
        'limit': limit,
      },
    );
  }

  Future<void> markPushNotificationRead(String id) async {
    await _request('POST', '/push/inbox/$id/read');
  }

  Future<void> markAllPushNotificationsRead() async {
    await _request('POST', '/push/inbox/read-all');
  }

  Future<Map<String, dynamic>> clientHome() => _request('GET', '/client/home');

  Future<Map<String, dynamic>> updateCustomerProfilePhoto(String imageBase64) {
    return _request(
      'PUT',
      '/client/profile-photo',
      data: <String, dynamic>{'imageBase64': imageBase64},
    );
  }

  Future<Map<String, dynamic>> updateCustomerProfile({
    required String name,
    required String address,
  }) {
    return _request(
      'PATCH',
      '/client/profile',
      data: <String, dynamic>{'name': name, 'address': address},
    );
  }

  Future<Map<String, dynamic>> securitySessions() =>
      _request('GET', '/security/sessions');

  Future<List<Map<String, dynamic>>> customerSecurityDevices() async {
    final response = await securitySessions();
    return _extractList(response, 'devices');
  }

  Future<Map<String, dynamic>> revokeSecuritySession(String id) =>
      _request('POST', '/security/sessions/$id/revoke');

  Future<Map<String, dynamic>> reviewSecuritySessionRequest({
    required String id,
    required bool approve,
  }) => _request(
    'POST',
    '/security/session-requests/$id/${approve ? 'approve' : 'reject'}',
  );

  Future<void> changeCustomerPassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    await _request(
      'POST',
      '/client/security/change-password',
      data: <String, dynamic>{
        'currentPassword': currentPassword,
        'newPassword': newPassword,
      },
    );
  }

  Future<void> logoutCustomerDevices() async {
    await _request('POST', '/client/security/logout-all');
  }

  Future<Map<String, dynamic>> mfaStatus() =>
      _request('GET', '/security/mfa/status');

  Future<Map<String, dynamic>> beginMandatoryMfaEnrollment(
    String enrollmentToken,
  ) => _request(
    'POST',
    '/auth/mfa-enrollment/setup',
    data: <String, dynamic>{'mfaEnrollmentToken': enrollmentToken},
    authenticated: false,
  );

  Future<Map<String, dynamic>> confirmMandatoryMfaEnrollment({
    required String enrollmentToken,
    required String secret,
    required String token,
    required List<String> recoveryCodes,
  }) => _request(
    'POST',
    '/auth/mfa-enrollment/confirm',
    data: <String, dynamic>{
      'mfaEnrollmentToken': enrollmentToken,
      'secret': secret,
      'token': token,
      'recoveryCodes': recoveryCodes,
    },
    authenticated: false,
  );

  Future<Map<String, dynamic>> beginMfaSetup() =>
      _request('POST', '/security/mfa/setup');

  Future<Map<String, dynamic>> confirmMfaSetup({
    required String secret,
    required String token,
    required List<String> recoveryCodes,
  }) {
    return _request(
      'POST',
      '/security/mfa/confirm',
      data: <String, dynamic>{
        'secret': secret,
        'token': token,
        'recoveryCodes': recoveryCodes,
      },
    );
  }

  Future<Map<String, dynamic>> disableMfa(String token) {
    return _request(
      'POST',
      '/security/mfa/disable',
      data: <String, dynamic>{'token': token},
    );
  }

  Future<Map<String, dynamic>> trustedMfaDevice() async {
    final deviceId = await _store.readOrCreateDeviceId();
    return _request(
      'GET',
      '/security/mfa/trusted-device',
      extraHeaders: <String, dynamic>{'X-Device-Id': deviceId},
    );
  }

  Future<Map<String, dynamic>> revokeTrustedMfaDevice() =>
      _request('POST', '/security/mfa/trusted-device/revoke');

  Future<Map<String, dynamic>> operationPinStatus() =>
      _request('GET', '/security/operation-pin/status');

  Future<Map<String, dynamic>> setupOperationPin(
    String pin, {
    required String mfaToken,
  }) => _request(
    'POST',
    '/security/operation-pin/setup',
    data: <String, dynamic>{'pin': pin},
    extraHeaders: <String, dynamic>{'X-MFA-Token': mfaToken},
  );

  Future<List<Map<String, dynamic>>> clientTransactions({
    int limit = 100,
    String? dateFrom,
    String? dateTo,
    String? search,
  }) async {
    final response = await _request(
      'GET',
      '/client/transactions',
      query: <String, dynamic>{
        'page': 1,
        'limit': limit,
        if (dateFrom?.isNotEmpty ?? false) 'dateFrom': dateFrom,
        if (dateTo?.isNotEmpty ?? false) 'dateTo': dateTo,
        if (search != null && search.trim().isNotEmpty) 'search': search.trim(),
      },
    );
    return _extractList(response, 'transactions');
  }

  Future<Map<String, dynamic>> transactionDetails(String id) {
    return _request('GET', '/client/transactions/$id');
  }

  /// Downloads the official customer-facing receipt through the authenticated
  /// mobile session. This keeps receipt viewing/sharing working even when the
  /// optional public receipt URL is not configured on the server.
  Future<Uint8List> clientReceiptImageBytes(String id, {int index = 0}) async {
    final session = await _store.read();
    if (session == null) {
      throw const ApiFailure(
        'انتهت جلسة الدخول، يرجى تسجيل الدخول مجدداً.',
        statusCode: 401,
      );
    }

    try {
      final response = await _dio.get<List<int>>(
        '/client/transactions/$id/receipt',
        queryParameters: <String, dynamic>{'index': index},
        options: Options(
          responseType: ResponseType.bytes,
          headers: <String, dynamic>{
            'Authorization': 'Bearer ${session.token}',
            'X-Correlation-Id': _uuid.v4(),
          },
        ),
      );
      final bytes = response.data;
      if (bytes == null || bytes.isEmpty) {
        throw const ApiFailure('الإيصال غير متاح حالياً.');
      }
      return Uint8List.fromList(bytes);
    } on DioException catch (error) {
      if (error.response?.statusCode == 401 && await _refresh()) {
        return clientReceiptImageBytes(id, index: index);
      }
      final body = _asMap(error.response?.data);
      throw ApiFailure(
        _failureMessage(body, fallback: _networkMessage(error)),
        statusCode: error.response?.statusCode,
        code: body['code']?.toString(),
      );
    }
  }

  Future<Map<String, dynamic>> clientReport({
    required String dateFrom,
    required String dateTo,
  }) async {
    if (dateFrom == dateTo) {
      return _request(
        'POST',
        '/client/reports/filter',
        data: _clientReportRequest(dateFrom: dateFrom, dateTo: dateTo),
      );
    }

    try {
      return await _request(
        'POST',
        '/client/reports/filter',
        data: _clientReportRequest(dateFrom: dateFrom, dateTo: dateTo),
      );
    } on ApiFailure catch (error) {
      // Production servers before the range-report release accept only day
      // and month. Build the requested period from the supported daily API.
      if (error.statusCode != 400 && error.statusCode != 404) rethrow;
      return _legacyRangeClientReport(dateFrom: dateFrom, dateTo: dateTo);
    }
  }

  Future<Uri> clientReportDownloadUrl({
    required String dateFrom,
    required String dateTo,
  }) async {
    final response = await _request(
      'POST',
      '/client/reports/download-link',
      data: _clientReportRequest(dateFrom: dateFrom, dateTo: dateTo),
    );
    final rawUrl = '${response['downloadUrl'] ?? ''}'.trim();
    final uri = Uri.tryParse(rawUrl);
    if (uri == null || !uri.hasScheme) {
      throw const ApiFailure('تعذر تجهيز رابط تنزيل التقرير.');
    }
    return uri;
  }

  // Older deployed servers accept only a single daily report. Keep the
  // current-day screen working while the range-report endpoint is deployed.
  Map<String, dynamic> _clientReportRequest({
    required String dateFrom,
    required String dateTo,
  }) {
    if (dateFrom == dateTo) {
      return <String, dynamic>{'dateType': 'day', 'dateValue': dateFrom};
    }
    return <String, dynamic>{
      'dateType': 'range',
      'dateFrom': dateFrom,
      'dateTo': dateTo,
    };
  }

  Future<Map<String, dynamic>> _legacyRangeClientReport({
    required String dateFrom,
    required String dateTo,
  }) async {
    final start = DateTime.parse(dateFrom);
    final end = DateTime.parse(dateTo);
    final dailyReports = <Map<String, dynamic>>[];

    for (
      var date = start;
      !date.isAfter(end);
      date = date.add(const Duration(days: 1))
    ) {
      final report = await _request(
        'POST',
        '/client/reports/filter',
        data: <String, dynamic>{
          'dateType': 'day',
          'dateValue': _reportDateValue(date),
        },
      );
      dailyReports.add(_asMap(report['data']));
    }

    final first = dailyReports.first;
    final last = dailyReports.last;
    final operations = <Map<String, dynamic>>[];
    final currentTransactions = <Map<String, dynamic>>[];
    final deposits = <Map<String, dynamic>>[];
    var totalLYD = 0.0;
    var totalEGP = 0.0;
    var completedCount = 0;
    var rejectedCount = 0;
    var totalDeposits = 0.0;

    for (final report in dailyReports) {
      operations.addAll(_reportRows(report['operations']));
      currentTransactions.addAll(_reportRows(report['currentTransactions']));
      deposits.addAll(_reportRows(report['deposits']));
      totalLYD += _reportNumber(report['totalLYD']);
      totalEGP += _reportNumber(report['totalEGP']);
      completedCount += _reportNumber(report['completedCount']).round();
      rejectedCount += _reportNumber(report['rejectedCount']).round();
      totalDeposits += _reportNumber(report['totalDeposits']);
    }

    final cancelledOperations = operations
        .where(
          (operation) => const <String>{
            'rejected',
            'cancelled',
            'cancelled_by_admin',
            'failed',
          }.contains('${operation['status']}'.toLowerCase()),
        )
        .toList();

    return <String, dynamic>{
      'success': true,
      'data': <String, dynamic>{
        'previousBalance': first['previousBalance'] ?? 0,
        'currentBalance': last['currentBalance'] ?? 0,
        'currentTransactions': currentTransactions,
        'operations': operations,
        'cancelledOperations': cancelledOperations,
        'deposits': deposits,
        'totalLYD': totalLYD,
        'totalEGP': totalEGP,
        'completedCount': completedCount,
        'rejectedCount': rejectedCount,
        'totalDeposits': totalDeposits,
        'operationCount': operations.length,
        'periodBalance': totalDeposits - totalLYD,
        'scope': 'client',
        'reportPeriod': <String, dynamic>{
          'type': 'range',
          'value': '$dateFrom إلى $dateTo',
        },
        'entityInfo': last['entityInfo'] ?? first['entityInfo'],
      },
    };
  }

  List<Map<String, dynamic>> _reportRows(Object? value) {
    if (value is! List) return const <Map<String, dynamic>>[];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList();
  }

  double _reportNumber(Object? value) {
    if (value is num) return value.toDouble();
    return double.tryParse('${value ?? ''}') ?? 0;
  }

  String _reportDateValue(DateTime value) {
    final year = value.year.toString().padLeft(4, '0');
    final month = value.month.toString().padLeft(2, '0');
    final day = value.day.toString().padLeft(2, '0');
    return '$year-$month-$day';
  }

  Future<Map<String, dynamic>> createTransfer(Map<String, dynamic> payload) {
    return _request(
      'POST',
      '/client/new-transfer',
      data: payload,
      idempotencyKey: _uuid.v4(),
    );
  }

  Future<Map<String, dynamic>> lookupBalanceTransferTarget(String accountCode) {
    return _request(
      'POST',
      '/client/balance-transfer/lookup',
      data: <String, dynamic>{'targetAccountCode': accountCode.trim()},
    );
  }

  Future<Map<String, dynamic>> createBalanceTransfer({
    required String targetAccountCode,
    required double amount,
    String? notes,
    String? operationPin,
  }) {
    return _request(
      'POST',
      '/client/balance-transfer',
      data: <String, dynamic>{
        'targetAccountCode': targetAccountCode.trim(),
        'amount': amount,
        if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
        if (operationPin != null && operationPin.trim().isNotEmpty)
          'operationPin': operationPin.trim(),
      },
      idempotencyKey: _uuid.v4(),
    );
  }

  Future<List<Map<String, dynamic>>> tickets() async {
    final response = await _request('GET', '/client/tickets');
    return _extractList(response, 'tickets');
  }

  Future<Map<String, dynamic>> createTicket({
    required String subject,
    required String message,
    String category = 'general',
  }) {
    return _request(
      'POST',
      '/client/tickets',
      data: <String, dynamic>{
        'subject': subject,
        'text': message,
        'category': category,
      },
    );
  }

  Future<Map<String, dynamic>> ticketDetails(String id) {
    return _request('GET', '/client/tickets/$id');
  }

  Future<Map<String, dynamic>> replyToTicket({
    required String id,
    required String text,
  }) {
    return _request(
      'POST',
      '/client/tickets/$id/reply',
      data: <String, dynamic>{'text': text.trim()},
    );
  }

  Future<Map<String, dynamic>> agentOverview() =>
      _request('GET', '/agent/overview');

  Future<List<Map<String, dynamic>>> agentSubAccounts() async {
    final response = await _request(
      'GET',
      '/agent/sub-accounts',
      query: <String, dynamic>{'page': 1, 'limit': 50, 'status': 'active'},
    );
    return _extractList(response, 'data');
  }

  Future<Map<String, dynamic>> createSubAccount(Map<String, dynamic> payload) {
    return _request(
      'POST',
      '/agent/sub-accounts',
      data: payload,
      idempotencyKey: _uuid.v4(),
    );
  }

  Future<Map<String, dynamic>> setSubAccountCreditLimit(
    String id,
    double creditLimit,
  ) {
    return _request(
      'PATCH',
      '/agent/sub-accounts/$id/credit-limit',
      data: <String, dynamic>{'creditLimit': creditLimit},
      idempotencyKey: _uuid.v4(),
    );
  }

  Future<Map<String, dynamic>> settleSubAccount({
    required String id,
    required String type,
    required double amount,
    required String notes,
  }) {
    return _request(
      'POST',
      '/agent/sub-accounts/$id/settlements',
      data: <String, dynamic>{'type': type, 'amount': amount, 'notes': notes},
      idempotencyKey: _uuid.v4(),
    );
  }

  Future<Map<String, dynamic>> executorLiveTasks() {
    return _request('GET', '/executor/live-tasks');
  }

  Future<Map<String, dynamic>> clearExecutorEmergencyAlert(String id) {
    return _request('POST', '/executor/alerts/$id/clear');
  }

  Future<Map<String, dynamic>> executorOverview() {
    return _request('GET', '/executor/overview');
  }

  Future<List<Map<String, dynamic>>> executorDepositRequests() async {
    final response = await _request('GET', '/executor/deposits');
    return _extractList(response, 'requests');
  }

  Future<Map<String, dynamic>> reviewExecutorDeposit({
    required String id,
    required bool approve,
    String reason = '',
  }) {
    return _request(
      'POST',
      '/executor/deposits/$id/review',
      data: <String, dynamic>{
        'decision': approve ? 'approve' : 'reject',
        if (!approve) 'reason': reason.trim(),
      },
      idempotencyKey: _uuid.v4(),
    );
  }

  Future<Map<String, dynamic>> executorSupportTickets({
    String status = 'active',
    String? category,
    String? search,
  }) {
    return _request(
      'GET',
      '/executor/support/tickets',
      query: <String, dynamic>{
        'status': status,
        if (category != null && category.isNotEmpty) 'category': category,
        if (search != null && search.trim().isNotEmpty) 'search': search.trim(),
      },
    );
  }

  Future<Map<String, dynamic>> executorSupportGroupChat() {
    return _request('GET', '/executor/support/group-chat');
  }

  Future<Map<String, dynamic>> replyToExecutorSupportGroupChat({
    String? message,
    List<String> imagesBase64 = const <String>[],
  }) {
    return _request(
      'POST',
      '/executor/support/group-chat/replies',
      data: <String, dynamic>{
        if (message != null && message.trim().isNotEmpty)
          'message': message.trim(),
        if (imagesBase64.isNotEmpty) 'imagesBase64': imagesBase64,
      },
      idempotencyKey: _uuid.v4(),
    );
  }

  Future<Map<String, dynamic>> createExecutorSupportTicket({
    required String subject,
    required String category,
    required String priority,
    required String message,
    String? transactionRef,
    List<String> imagesBase64 = const <String>[],
    Map<String, dynamic>? diagnostics,
  }) {
    return _request(
      'POST',
      '/executor/support/tickets',
      data: <String, dynamic>{
        'subject': subject.trim(),
        'category': category,
        'priority': priority,
        'message': message.trim(),
        if (transactionRef != null && transactionRef.trim().isNotEmpty)
          'transactionRef': transactionRef.trim(),
        if (imagesBase64.isNotEmpty) 'imagesBase64': imagesBase64,
        'diagnostics': ?diagnostics,
      },
      idempotencyKey: _uuid.v4(),
    );
  }

  Future<Map<String, dynamic>> executorSupportTicketDetails(String id) {
    return _request('GET', '/executor/support/tickets/$id');
  }

  Future<Map<String, dynamic>> replyToExecutorSupportTicket({
    required String id,
    String? message,
    List<String> imagesBase64 = const <String>[],
  }) {
    return _request(
      'POST',
      '/executor/support/tickets/$id/replies',
      data: <String, dynamic>{
        if (message != null && message.trim().isNotEmpty)
          'message': message.trim(),
        if (imagesBase64.isNotEmpty) 'imagesBase64': imagesBase64,
      },
      idempotencyKey: _uuid.v4(),
    );
  }

  Future<Map<String, dynamic>> executorSupportDiagnostics() {
    return _request('GET', '/executor/support/diagnostics');
  }

  Future<Map<String, dynamic>> executorReports({
    required String dateType,
    required String dateValue,
    String? dateFrom,
    String? dateTo,
    String? employeeId,
    String? search,
  }) {
    return _request(
      'POST',
      '/executor/reports/filter',
      data: <String, dynamic>{
        'dateType': dateType,
        'dateValue': dateValue,
        if (dateFrom != null && dateFrom.isNotEmpty) 'dateFrom': dateFrom,
        if (dateTo != null && dateTo.isNotEmpty) 'dateTo': dateTo,
        if (employeeId != null && employeeId.isNotEmpty)
          'employeeId': employeeId,
        if (search != null && search.trim().isNotEmpty) 'search': search.trim(),
      },
    );
  }

  Future<Uint8List> executorTransactionImageBytes(
    String id, {
    String source = 'official',
    int index = 0,
  }) async {
    final ticketResponse = await _request(
      'GET',
      '/transaction/image/$id',
      query: <String, dynamic>{
        if (source == 'executor') 'source': source,
        'index': index,
      },
    );
    final rawUrl = '${ticketResponse['url'] ?? ''}'.trim();
    final uri = Uri.tryParse(rawUrl);
    if (uri == null || !uri.hasScheme) {
      throw const ApiFailure('تعذر تجهيز صورة الإيصال.');
    }
    final session = await _store.read();
    if (session == null) {
      throw const ApiFailure(
        'انتهت جلسة الدخول، يرجى تسجيل الدخول مجدداً.',
        statusCode: 401,
      );
    }
    try {
      final response = await _dio.get<List<int>>(
        uri.toString(),
        options: Options(
          responseType: ResponseType.bytes,
          headers: <String, dynamic>{
            'Authorization': 'Bearer ${session.token}',
            'X-Correlation-Id': _uuid.v4(),
          },
        ),
      );
      final bytes = response.data;
      if (bytes == null || bytes.isEmpty) {
        throw const ApiFailure('صورة الإيصال غير متاحة.');
      }
      return Uint8List.fromList(bytes);
    } on DioException catch (error) {
      throw ApiFailure(
        _failureMessage(
          _asMap(error.response?.data),
          fallback: _networkMessage(error),
        ),
        statusCode: error.response?.statusCode,
      );
    }
  }

  Future<Uri> executorReportDownloadUrl({
    required String dateType,
    required String dateValue,
    String? dateFrom,
    String? dateTo,
    String? employeeId,
    String? search,
  }) async {
    final response = await _request(
      'POST',
      '/executor/reports/download-link',
      data: <String, dynamic>{
        'dateType': dateType,
        'dateValue': dateValue,
        if (dateFrom != null && dateFrom.isNotEmpty) 'dateFrom': dateFrom,
        if (dateTo != null && dateTo.isNotEmpty) 'dateTo': dateTo,
        if (employeeId != null && employeeId.isNotEmpty)
          'employeeId': employeeId,
        if (search != null && search.trim().isNotEmpty) 'search': search.trim(),
      },
    );
    final rawUrl = '${response['downloadUrl'] ?? ''}'.trim();
    final uri = Uri.tryParse(rawUrl);
    if (uri == null || !uri.hasScheme) {
      throw const ApiFailure('تعذر تجهيز رابط تنزيل التقرير.');
    }
    return uri;
  }

  Future<List<Map<String, dynamic>>> executorEmployees() async {
    final response = await _request('GET', '/executor/employees');
    return _extractList(response, 'employees');
  }

  Future<Map<String, dynamic>> executorEmployeesWorkspace() {
    return _request('GET', '/executor/employees');
  }

  Future<Map<String, dynamic>> createExecutorEmployee({
    required String name,
    required String phone,
    required String role,
    required String username,
    required String password,
  }) {
    return _request(
      'POST',
      '/executor/employees',
      data: <String, dynamic>{
        'name': name,
        'phone': phone,
        'role': role,
        'webUsername': username,
        'webPassword': password,
      },
    );
  }

  Future<Map<String, dynamic>> updateExecutorEmployee({
    required String id,
    required String name,
    required String phone,
  }) {
    return _request(
      'PATCH',
      '/executor/employees/$id/profile',
      data: <String, dynamic>{'name': name, 'phone': phone},
    );
  }

  Future<Map<String, dynamic>> toggleExecutorEmployeeStatus(String id) {
    return _request('PATCH', '/executor/employees/$id/status');
  }

  Future<Map<String, dynamic>> toggleExecutorEmployeeReports(String id) {
    return _request('PATCH', '/executor/employees/$id/reports-permission');
  }

  Future<Map<String, dynamic>> resetExecutorEmployeePassword({
    required String id,
    required String password,
  }) {
    return _request(
      'POST',
      '/executor/employees/$id/reset-password',
      data: <String, dynamic>{'newPassword': password},
    );
  }

  Future<Map<String, dynamic>> deleteExecutorEmployee(String id) {
    return _request('DELETE', '/executor/employees/$id');
  }

  Future<Map<String, dynamic>> acceptTask(String id, {String? idempotencyKey}) {
    // Keep the key across the automatic 401 refresh retry. The server also
    // treats a completed accept as a replay, covering duplicate taps and
    // network retries without showing a false failure to the executor.
    return _request(
      'POST',
      '/executor/accept-task/$id',
      idempotencyKey: idempotencyKey ?? 'executor-accept-${id}_${_uuid.v4()}',
    );
  }

  Future<Map<String, dynamic>> setExecutorTaskRoutingMode(bool enabled) {
    return _request(
      'POST',
      '/executor/task-routing-mode',
      data: <String, dynamic>{'enabled': enabled},
    );
  }

  Future<List<Map<String, dynamic>>> executorRouteCandidates() async {
    final response = await _request('GET', '/executor/route-candidates');
    return _extractList(response, 'data');
  }

  Future<Map<String, dynamic>> routeExecutorTask({
    required String taskId,
    required String employeeId,
  }) {
    return _request(
      'POST',
      '/executor/route-task/$taskId',
      data: <String, dynamic>{'employeeId': employeeId},
    );
  }

  Future<Map<String, dynamic>> cancelTask(String id, String reason) {
    return _request(
      'POST',
      '/executor/cancel-task/$id',
      data: <String, dynamic>{'reason': reason},
    );
  }

  Future<Map<String, dynamic>> completeTask({
    required String id,
    required String executionNumber,
    String? imageBase64,
    List<String>? imagesBase64,
    List<Map<String, dynamic>>? senderEntries,
  }) {
    return _request(
      'POST',
      '/executor/complete-task/$id',
      data: <String, dynamic>{
        'executionNumber': executionNumber,
        if (imageBase64 != null && imageBase64.isNotEmpty)
          'imageBase64': imageBase64,
        if (imagesBase64 != null && imagesBase64.isNotEmpty)
          'imagesBase64': imagesBase64,
        if (senderEntries != null && senderEntries.isNotEmpty)
          'senderEntries': senderEntries,
      },
    );
  }

  List<Map<String, dynamic>> _extractList(
    Map<String, dynamic> response,
    String key,
  ) {
    final candidate = response[key] ?? response['data'];
    if (candidate is! List) return <Map<String, dynamic>>[];
    return candidate
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  Future<Map<String, dynamic>> _request(
    String method,
    String path, {
    dynamic data,
    Map<String, dynamic>? query,
    bool authenticated = true,
    bool retryAfterRefresh = true,
    String? idempotencyKey,
    Map<String, dynamic>? extraHeaders,
  }) async {
    final headers = <String, dynamic>{'X-Correlation-Id': _uuid.v4()};
    headers['X-Device-Id'] = await _store.readOrCreateDeviceId();
    headers['X-Client-Channel'] = 'app';
    if (extraHeaders != null) headers.addAll(extraHeaders);
    if (idempotencyKey != null && idempotencyKey.isNotEmpty) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    if (authenticated) {
      final session = await _store.read();
      if (session == null) {
        throw const ApiFailure(
          'انتهت جلسة الدخول، يرجى تسجيل الدخول مجدداً.',
          statusCode: 401,
        );
      }
      headers['Authorization'] = 'Bearer ${session.token}';
    }

    try {
      final response = await _dio.request<dynamic>(
        path,
        data: data,
        queryParameters: query,
        options: Options(method: method, headers: headers),
      );
      final body = _asMap(response.data);
      if (body['success'] == false) {
        throw ApiFailure(
          _failureMessage(body),
          statusCode: response.statusCode,
          code: body['code']?.toString(),
          data: body,
        );
      }
      return body;
    } on DioException catch (error) {
      final status = error.response?.statusCode;
      if (authenticated &&
          status == 401 &&
          retryAfterRefresh &&
          await _refresh()) {
        return _request(
          method,
          path,
          data: data,
          query: query,
          authenticated: authenticated,
          retryAfterRefresh: false,
          idempotencyKey: idempotencyKey,
          extraHeaders: extraHeaders,
        );
      }
      final body = _asMap(error.response?.data);
      throw ApiFailure(
        _failureMessage(body, fallback: _networkMessage(error)),
        statusCode: status,
        code: body['code']?.toString(),
        data: body,
      );
    }
  }

  Future<bool> _refresh() {
    return _refreshing ??= _refreshToken().whenComplete(
      () => _refreshing = null,
    );
  }

  Future<bool> _refreshToken() async {
    final session = await _store.read();
    if (session == null || session.refreshToken.isEmpty) return false;
    try {
      final response = await _dio.post<dynamic>(
        '/refresh-token',
        data: <String, dynamic>{'refreshToken': session.refreshToken},
        options: Options(
          headers: <String, dynamic>{
            'X-Correlation-Id': _uuid.v4(),
            'X-Device-Id': await _store.readOrCreateDeviceId(),
            'X-Client-Channel': 'app',
          },
        ),
      );
      final body = _asMap(response.data);
      if (body['success'] != true || '${body['token'] ?? ''}'.isEmpty) {
        return false;
      }
      await _store.write(
        session.copyWith(
          token: '${body['token']}',
          refreshToken: body['refreshToken']?.toString(),
        ),
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  Map<String, dynamic> _asMap(dynamic value) {
    if (value is Map) return Map<String, dynamic>.from(value);
    return <String, dynamic>{};
  }

  String _failureMessage(Map<String, dynamic> body, {String? fallback}) {
    final message = body['message'] ?? body['error'];
    if (message != null && '$message'.trim().isNotEmpty) return '$message';
    return fallback ?? 'تعذر إتمام الطلب حالياً، يرجى المحاولة مرة أخرى.';
  }

  String _networkMessage(DioException error) {
    if (error.type == DioExceptionType.connectionTimeout ||
        error.type == DioExceptionType.receiveTimeout ||
        error.type == DioExceptionType.sendTimeout) {
      return 'انتهت مهلة الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة.';
    }
    if (error.type == DioExceptionType.connectionError) {
      return 'تعذر الاتصال بالخادم. تحقق من الإنترنت أو حالة الخدمة.';
    }
    return 'تعذر إتمام الطلب حالياً، يرجى المحاولة مرة أخرى.';
  }
}

class SessionController extends ChangeNotifier {
  SessionController(this.store) : api = MobileApi(store);

  final SessionStore store;
  final MobileApi api;
  MobileSession? session;
  bool isReady = false;
  bool customerNotificationsEnabled = true;

  bool get isExecutor => session?.accountType == 'executor';

  String get executorRole {
    // The context is the executor-specific contract. Older sessions can carry
    // a generic role value such as "executor", which must not hide manager UI.
    final contextRole = _knownExecutorRole(session?.context['executorRole']);
    final sessionRole = _knownExecutorRole(session?.role);
    return contextRole ?? sessionRole ?? 'operator';
  }

  String? _knownExecutorRole(Object? value) {
    final role = '${value ?? ''}'.trim().toLowerCase();
    return switch (role) {
      'manager' || 'operator' || 'accountant' => role,
      _ => null,
    };
  }

  bool get isExecutorManager => isExecutor && executorRole == 'manager';
  bool get isExecutorAccountant => isExecutor && executorRole == 'accountant';
  bool get isExecutorOperator =>
      isExecutor && !isExecutorManager && !isExecutorAccountant;

  bool get isAgent {
    final persona = session?.persona.toLowerCase() ?? '';
    return persona == 'agentowner' || persona == 'agentmanager';
  }

  bool get isCompany {
    final persona = session?.persona.toLowerCase() ?? '';
    return session?.accountType == 'client_company' ||
        persona.startsWith('company');
  }

  WorkspaceKind get workspaceKind {
    final current = session;
    if (current == null) return WorkspaceKind.customerWallet;
    return resolveWorkspaceKind(
      accountType: current.accountType,
      persona: current.persona,
      executorRole: executorRole,
    );
  }

  bool get isCompanyEmployee => workspaceKind == WorkspaceKind.companyExecution;

  bool get isCompanyAccountant =>
      workspaceKind == WorkspaceKind.companyAccountant;

  bool get isCompanyManager => workspaceKind == WorkspaceKind.companyManager;

  bool get isAgentStaff => workspaceKind == WorkspaceKind.agentStaff;

  bool get canInternalTransfer =>
      isCompany ? isCompanyManager : !isCompanyEmployee;

  bool get canCreateTransfer =>
      workspaceKind != WorkspaceKind.companyAccountant &&
      workspaceKind != WorkspaceKind.executorControl;

  bool get canAcceptExecutorTasks => isExecutor && !isExecutorAccountant;

  bool get canCompleteExecutorProof => canAcceptExecutorTasks;

  bool get canRouteExecutorTasks => isExecutorManager;

  bool get canRequestCompanyDeposit => isCompanyManager;

  bool _hasPermission(String key) {
    return session?.permissions.contains(key) ?? false;
  }

  bool get canViewAgentCustomers =>
      isAgent || _hasPermission('agent.sub_accounts.read');

  bool get canCreateAgentCustomers =>
      isAgent || _hasPermission('agent.sub_accounts.create');

  bool get canManageAgentCustomers =>
      isAgent ||
      _hasPermission('agent.sub_accounts.update_credit_limit') ||
      _hasPermission('agent.sub_accounts.settle');

  bool get isCustomerAccount {
    if (isExecutor || isAgent || isCompany) return false;
    final accountType = session?.accountType ?? '';
    final persona = session?.persona.toLowerCase() ?? '';
    return accountType == 'sub_client' ||
        (accountType == 'client_user' &&
            (persona == 'directclient' || persona == 'agentclient'));
  }

  bool get receivesClientNotifications => const <String>{
    'client_user',
    'client_company',
    'sub_client',
    'agent_staff',
  }.contains(session?.accountType);

  bool get hidesBalance {
    if (isCompanyAccountant) return false;
    final persona = session?.persona.toLowerCase() ?? '';
    return persona.contains('employee');
  }

  Future<void> restore() async {
    session = await store.read();
    customerNotificationsEnabled = await store
        .readCustomerNotificationsEnabled();
    isReady = true;
    notifyListeners();
  }

  Future<void> signIn({
    required String username,
    required String password,
    String? mfaToken,
    bool trustDevice = true,
  }) async {
    final nextSession = await api.login(
      username: username,
      password: password,
      mfaToken: mfaToken,
      trustDevice: trustDevice,
    );
    session = nextSession;
    await store.write(nextSession);
    notifyListeners();
  }

  Future<SavedLoginCredentials?> savedLogin() => store.readSavedLogin();

  Future<void> saveLogin({
    required String username,
    required String password,
  }) => store.saveLogin(username: username, password: password);

  Future<void> clearSavedLogin() => store.clearSavedLogin();

  Future<Map<String, dynamic>> refreshHome() async {
    final home = await api.clientHome();
    final current = session;
    if (current != null) {
      session = current.applyHome(home);
      await store.write(session!);
      notifyListeners();
    }
    return home;
  }

  Future<void> updateCustomerProfilePhoto(String imageBase64) async {
    final response = await api.updateCustomerProfilePhoto(imageBase64);
    final current = session;
    if (current == null) return;
    final nextContext = Map<String, dynamic>.from(current.context);
    final currentProfile = nextContext['profile'];
    final profile = currentProfile is Map
        ? Map<String, dynamic>.from(currentProfile)
        : <String, dynamic>{};
    final responseProfile = response['profile'];
    if (responseProfile is Map) {
      profile.addAll(Map<String, dynamic>.from(responseProfile));
    }
    nextContext['profile'] = profile;
    session = current.copyWith(context: nextContext);
    await store.write(session!);
    notifyListeners();
  }

  Future<void> updateCustomerProfile({
    required String name,
    required String address,
  }) async {
    final response = await api.updateCustomerProfile(
      name: name,
      address: address,
    );
    final current = session;
    if (current == null) return;
    final nextContext = Map<String, dynamic>.from(current.context);
    final rawProfile = nextContext['profile'];
    final profile = rawProfile is Map
        ? Map<String, dynamic>.from(rawProfile)
        : <String, dynamic>{};
    final responseProfile = response['profile'];
    if (responseProfile is Map) {
      profile.addAll(Map<String, dynamic>.from(responseProfile));
    }
    nextContext['profile'] = profile;
    session = current.copyWith(
      name: profile['name']?.toString(),
      context: nextContext,
    );
    await store.write(session!);
    notifyListeners();
  }

  Future<List<Map<String, dynamic>>> customerSecurityDevices() {
    return api.customerSecurityDevices();
  }

  Future<Map<String, dynamic>> securitySessions() => api.securitySessions();

  Future<Map<String, dynamic>> revokeSecuritySession(String id) =>
      api.revokeSecuritySession(id);

  Future<Map<String, dynamic>> reviewSecuritySessionRequest({
    required String id,
    required bool approve,
  }) => api.reviewSecuritySessionRequest(id: id, approve: approve);

  Future<void> setCustomerNotificationsEnabled(bool enabled) async {
    customerNotificationsEnabled = enabled;
    await store.setCustomerNotificationsEnabled(enabled);
    notifyListeners();
  }

  Future<void> changeCustomerPassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    await api.changeCustomerPassword(
      currentPassword: currentPassword,
      newPassword: newPassword,
    );
    await store.clear();
    session = null;
    notifyListeners();
  }

  Future<void> logoutCustomerDevices() async {
    await api.logoutCustomerDevices();
    // The server keeps the current device session active and revokes only the
    // other mobile devices, so the current customer stays signed in.
    notifyListeners();
  }

  Future<void> signOut() async {
    await api.logout();
    await store.clear();
    session = null;
    notifyListeners();
  }

  Future<void> clearLocalSession() async {
    await store.clear();
    session = null;
    notifyListeners();
  }
}
