enum CustomerLayoutMode { compact, phone, tablet, desktop }

CustomerLayoutMode customerLayoutMode(double width) {
  if (width >= 1200) return CustomerLayoutMode.desktop;
  if (width >= 850) return CustomerLayoutMode.tablet;
  if (width >= 390) return CustomerLayoutMode.phone;
  return CustomerLayoutMode.compact;
}

bool customerUseBottomNav(double width) => width < 850;

bool customerUseSidebar(double width) => width >= 850;

bool customerShowInspector(double width) => width >= 1200;

int customerGridColumns(double width, {int max = 3}) {
  final mode = customerLayoutMode(width);
  return switch (mode) {
    CustomerLayoutMode.desktop => max,
    CustomerLayoutMode.tablet => max > 2 ? 2 : max,
    CustomerLayoutMode.phone => 2,
    CustomerLayoutMode.compact => 1,
  };
}
