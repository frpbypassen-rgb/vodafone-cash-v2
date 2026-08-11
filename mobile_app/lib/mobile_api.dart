import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

class ApiFailure implements Exception {
  const ApiFailure(this.message, {this.statusCode, this.code});

  final String message;
  final int? statusCode;
  final String? code;

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
    double? balance,
    int? tier,
    double? exchangeRate,
    double? baseExchangeRate,
    Map<String, dynamic>? serviceRates,
    List<Map<String, dynamic>>? serviceCatalog,
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
      name: name,
      balance: balance ?? this.balance,
      tier: tier ?? this.tier,
      exchangeRate: exchangeRate ?? this.exchangeRate,
      baseExchangeRate: baseExchangeRate ?? this.baseExchangeRate,
      serviceRates: serviceRates ?? this.serviceRates,
      serviceCatalog: serviceCatalog ?? this.serviceCatalog,
      isOpen: isOpen ?? this.isOpen,
      context: context,
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
    );
  }
}

class SessionStore {
  static const _sessionKey = 'power_pay_mobile_session_v1';
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
          },
        ),
      );

  final SessionStore _store;
  final Dio _dio;
  final Uuid _uuid = const Uuid();
  Future<bool>? _refreshing;

  String get baseUrl => _dio.options.baseUrl;

  Future<MobileSession> login({
    required String username,
    required String password,
  }) async {
    final response = await _request(
      'POST',
      '/login',
      data: <String, dynamic>{'username': username, 'password': password},
      authenticated: false,
    );
    final session = MobileSession.fromJson(response);
    if (session.token.isEmpty || session.refreshToken.isEmpty) {
      throw const ApiFailure('تعذر إنشاء جلسة الدخول، يرجى المحاولة لاحقاً.');
    }
    return session;
  }

  Future<void> logout() async {
    try {
      await _request('POST', '/logout');
    } catch (_) {
      // Local session removal must still succeed when the device is offline.
    }
  }

  Future<Map<String, dynamic>> clientHome() => _request('GET', '/client/home');

  Future<List<Map<String, dynamic>>> clientTransactions({
    int limit = 30,
  }) async {
    final response = await _request(
      'GET',
      '/client/transactions',
      query: <String, dynamic>{'page': 1, 'limit': limit},
    );
    return _extractList(response, 'transactions');
  }

  Future<Map<String, dynamic>> transactionDetails(String id) {
    return _request('GET', '/client/transactions/$id');
  }

  Future<Map<String, dynamic>> createTransfer(Map<String, dynamic> payload) {
    return _request(
      'POST',
      '/client/new-transfer',
      data: payload,
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
  }) {
    return _request(
      'POST',
      '/client/tickets',
      data: <String, dynamic>{
        'subject': subject,
        'message': message,
        'category': 'general',
      },
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

  Future<Map<String, dynamic>> executorOverview() {
    return _request('GET', '/executor/overview');
  }

  Future<Map<String, dynamic>> executorReports({
    required String dateType,
    required String dateValue,
    String? employeeId,
  }) {
    return _request(
      'POST',
      '/executor/reports/filter',
      data: <String, dynamic>{
        'dateType': dateType,
        'dateValue': dateValue,
        if (employeeId != null && employeeId.isNotEmpty)
          'employeeId': employeeId,
      },
    );
  }

  Future<Uri> executorReportDownloadUrl({
    required String dateType,
    required String dateValue,
    String? employeeId,
  }) async {
    final response = await _request(
      'POST',
      '/executor/reports/download-link',
      data: <String, dynamic>{
        'dateType': dateType,
        'dateValue': dateValue,
        if (employeeId != null && employeeId.isNotEmpty)
          'employeeId': employeeId,
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

  Future<Map<String, dynamic>> acceptTask(String id) {
    return _request('POST', '/executor/accept-task/$id');
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
  }) {
    return _request(
      'POST',
      '/executor/complete-task/$id',
      data: <String, dynamic>{
        'executionNumber': executionNumber,
        if (imageBase64 != null && imageBase64.isNotEmpty)
          'imageBase64': imageBase64,
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
  }) async {
    final headers = <String, dynamic>{
      'X-Correlation-Id': _uuid.v4(),
      'Idempotency-Key': ?idempotencyKey,
    };
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
        );
      }
      final body = _asMap(error.response?.data);
      throw ApiFailure(
        _failureMessage(body, fallback: _networkMessage(error)),
        statusCode: status,
        code: body['code']?.toString(),
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
          headers: <String, dynamic>{'X-Correlation-Id': _uuid.v4()},
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

  bool get hidesBalance {
    final persona = session?.persona.toLowerCase() ?? '';
    return persona.contains('employee') || persona.contains('accountant');
  }

  Future<void> restore() async {
    session = await store.read();
    isReady = true;
    notifyListeners();
  }

  Future<void> signIn({
    required String username,
    required String password,
  }) async {
    final nextSession = await api.login(username: username, password: password);
    session = nextSession;
    await store.write(nextSession);
    notifyListeners();
  }

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

  Future<void> signOut() async {
    await api.logout();
    await store.clear();
    session = null;
    notifyListeners();
  }
}
