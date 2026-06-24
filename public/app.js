const state = {
  token: localStorage.getItem("salesSession") || "",
  user: null,
  currentView: location.hash.slice(1) || "overview",
  invoices: [],
  products: [],
  users: [],
  page: 1,
  pageSize: 50,
  searchTimer: null,
  selectedInvoiceId: null,
  editingProductId: null,
  editingUserId: null,
  refreshClicks: [],
  pendingAnnouncements: []
};

const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  const ids = [
    "loginView", "dashboardView", "loginForm", "loginError", "apiKey", "toggleKey",
    "logoutButton", "refreshButton", "connectionStatus", "lastUpdated", "pageEyebrow",
    "pageTitle", "overviewView", "invoicesView", "productsView", "cashView", "usersView",
    "logsView", "announcementsView", "currentUser", "showAllInvoices", "searchInput",
    "fromDate", "toDate", "invoiceSort", "invoicePageSize", "clearFilters", "exportInvoices",
    "totalSales", "invoiceCount", "itemsSold", "averageInvoice", "salesChart",
    "topProducts", "recentInvoices", "invoiceRows", "invoiceResultLabel", "emptyState",
    "filteredInvoiceCount", "filteredInvoiceTotal", "largestInvoice", "previousPage",
    "nextPage", "pageLabel", "invoiceDialog", "closeDialog", "dialogTitle",
    "dialogMeta", "dialogItems", "dialogTotal", "copyInvoiceNumber", "printInvoice",
    "todayReportDate", "todayExpectedCash", "todayActualCash", "todayVariance",
    "productSearch", "addProductButton", "productCount", "lowStockCount", "stockCostValue",
    "expectedProfit", "productRows", "cashDate", "loadCashReport", "cashExpected",
    "cashInvoiceCount", "cashActual", "cashVariance", "cashVarianceCard", "cashCloseForm",
    "actualCashInput", "cashNotes", "cashClosedInfo", "addUserButton", "userRows",
    "refreshLogs", "logRows", "productDialog", "productForm", "productDialogTitle",
    "productName", "productBarcode", "productStock", "productSalePrice", "productCostPrice",
    "productLowStock", "productActive", "userDialog", "userForm", "userDialogTitle",
    "userDisplayName", "userRole", "userPassword", "userActive", "addAnnouncementButton",
    "announcementRows", "announcementDialog", "announcementForm", "announcementTitle",
    "announcementMessage", "toast"
  ];
  ids.forEach((id) => { elements[id] = document.querySelector(`#${id}`); });
  elements.navItems = [...document.querySelectorAll("[data-view]")];
  elements.periodButtons = [...document.querySelectorAll("[data-period]")];

  bindEvents();
  refreshIcons();

  if (state.token) restoreSession();
});

function bindEvents() {
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.toggleKey.addEventListener("click", () => {
    elements.apiKey.type = elements.apiKey.type === "password" ? "text" : "password";
  });
  elements.logoutButton.addEventListener("click", logout);
  elements.refreshButton.addEventListener("click", handleRefreshClick);
  elements.closeDialog.addEventListener("click", () => elements.invoiceDialog.close());
  elements.invoiceDialog.addEventListener("click", (event) => {
    if (event.target === elements.invoiceDialog) elements.invoiceDialog.close();
  });
  elements.navItems.forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  document.querySelectorAll("[data-open-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.openView));
  });
  elements.showAllInvoices.addEventListener("click", () => switchView("invoices"));
  elements.periodButtons.forEach((button) => {
    button.addEventListener("click", () => applyPeriod(button.dataset.period));
  });
  elements.searchInput.addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.page = 1;
      logClient("INVOICE_SEARCHED", { query: elements.searchInput.value.trim() });
      loadDashboard();
    }, 350);
  });
  elements.fromDate.addEventListener("change", filtersChanged);
  elements.toDate.addEventListener("change", filtersChanged);
  elements.invoiceSort.addEventListener("change", () => {
    state.page = 1;
    renderInvoicePage();
  });
  elements.invoicePageSize.addEventListener("change", () => {
    state.pageSize = elements.invoicePageSize.value === "all"
      ? Number.MAX_SAFE_INTEGER
      : Number(elements.invoicePageSize.value);
    state.page = 1;
    renderInvoicePage();
  });
  elements.clearFilters.addEventListener("click", clearFilters);
  elements.exportInvoices.addEventListener("click", exportCsv);
  elements.previousPage.addEventListener("click", () => changePage(-1));
  elements.nextPage.addEventListener("click", () => changePage(1));
  elements.copyInvoiceNumber.addEventListener("click", copyInvoiceNumber);
  elements.printInvoice.addEventListener("click", () => window.print());
  elements.productSearch.addEventListener("input", () => {
    renderProductsTable();
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      logClient("PRODUCT_SEARCHED", { query: elements.productSearch.value.trim() });
    }, 500);
  });
  elements.addProductButton.addEventListener("click", () => openProductForm());
  elements.productForm.addEventListener("submit", saveProduct);
  elements.loadCashReport.addEventListener("click", loadCashReport);
  elements.cashDate.addEventListener("change", loadCashReport);
  elements.cashCloseForm.addEventListener("submit", closeCashDay);
  elements.addUserButton.addEventListener("click", () => openUserForm());
  elements.userForm.addEventListener("submit", saveUser);
  elements.refreshLogs.addEventListener("click", loadLogs);
  elements.addAnnouncementButton.addEventListener("click", () => elements.announcementDialog.showModal());
  elements.announcementForm.addEventListener("submit", saveAnnouncement);
  document.querySelectorAll(".dialog-close").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });
  document.addEventListener("click", (event) => {
    const control = event.target.closest("button, a");
    if (!control || !state.token) return;
    logClient("CONTROL_CLICKED", {
      view: state.currentView,
      control_id: control.id || null,
      label: (control.textContent || control.title || "").trim().slice(0, 120)
    });
  });
  document.addEventListener("change", (event) => {
    const control = event.target;
    if (!state.token || !control.matches("input, select, textarea") ||
        control.type === "password" || control.id === "apiKey" ||
        control.id === "userPassword") return;
    logClient("FIELD_CHANGED", {
      view: state.currentView,
      field_id: control.id || null,
      value: String(control.type === "checkbox" ? control.checked : control.value).slice(0, 300)
    });
  });
  window.addEventListener("hashchange", () => {
    switchView(location.hash.slice(1) || "overview", false);
  });
}

async function handleLogin(event) {
  event.preventDefault();
  elements.loginError.textContent = "";
  const password = elements.apiKey.value;
  if (!password) return;

  try {
    const data = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
      skipAuth: true
    });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem("salesSession", state.token);
    showDashboard();
    applyPermissions();
    switchView(state.currentView, false);
    await loadInitialData();
  } catch (error) {
    elements.loginError.textContent =
      error.status === 401 ? "كلمة المرور غير صحيحة." : "تعذر الاتصال بالخادم.";
  }
}

async function restoreSession() {
  try {
    const data = await apiFetch("/api/auth/me");
    state.user = data.user;
    showDashboard();
    applyPermissions();
    switchView(state.currentView, false);
    await loadInitialData();
  } catch {
    logout(false);
  }
}

async function loadInitialData() {
  elements.cashDate.value = localDate(new Date());
  await Promise.all([loadDashboard(), loadCashReport()]);
}

function showDashboard() {
  elements.loginView.hidden = true;
  elements.dashboardView.hidden = false;
  refreshIcons();
}

async function logout(callServer = true) {
  if (callServer && state.token) {
    apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  }
  localStorage.removeItem("salesSession");
  state.token = "";
  state.user = null;
  elements.apiKey.value = "";
  elements.dashboardView.hidden = true;
  elements.loginView.hidden = false;
}

function switchView(view, updateHash = true) {
  const titles = {
    overview: ["لوحة التحكم", "نظرة عامة على المبيعات"],
    invoices: ["إدارة المبيعات", "الفواتير"],
    products: ["إدارة المخزون", "المنتجات"],
    cash: ["المراجعة اليومية", "إقفال اليومية"],
    users: ["إدارة النظام", "المستخدمون والصلاحيات"],
    logs: ["مراقبة النظام", "سجل النشاط"],
    announcements: ["التواصل الداخلي", "الإعلانات"]
  };
  if (!titles[view] || !canOpenView(view)) view = "overview";
  state.currentView = view;
  document.querySelectorAll(".page-view").forEach((section) => {
    section.hidden = section.id !== `${view}View`;
  });
  elements.pageEyebrow.textContent = titles[view][0];
  elements.pageTitle.textContent = titles[view][1];
  elements.navItems.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.currentView);
  });
  if (updateHash) {
    history.pushState(null, "", `#${view}`);
  }
  if (view === "invoices") renderInvoicePage();
  if (view === "products") loadProducts();
  if (view === "cash") loadCashReport();
  if (view === "users") loadUsers();
  if (view === "logs") loadLogs();
  if (view === "announcements") loadAnnouncements();
  logClient("PAGE_OPENED", { view });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.skipAuth ? {} : { Authorization: `Bearer ${state.token}` })
    },
    body: options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

function applyPermissions() {
  const permissions = state.user?.permissions || [];
  document.querySelectorAll("[data-permission]").forEach((element) => {
    element.hidden = !permissions.includes(element.dataset.permission);
  });
  elements.currentUser.innerHTML = `
    <strong>${escapeHtml(state.user.display_name)}</strong>
    <span>${escapeHtml(roleName(state.user.role))}</span>`;
}

function can(permission) {
  return state.user?.permissions?.includes(permission);
}

function canOpenView(view) {
  const permission = {
    overview: "dashboard:view", invoices: "invoices:view", products: "products:view",
    cash: "cash:view", users: "users:manage", logs: "logs:view",
    announcements: "announcements:manage"
  }[view];
  return can(permission);
}

async function loadDashboard() {
  setLoading(true);
  const params = currentParams();

  try {
    const data = await apiFetch(`/api/dashboard?${params}`);
    state.invoices = data.invoices;
    renderSummary(data.summary);
    renderChart(data.daily_sales);
    renderProducts(data.top_products);
    renderRecentInvoices(data.invoices.slice(0, 4));
    renderInvoicePage();
    elements.lastUpdated.textContent = `آخر تحديث ${new Intl.DateTimeFormat("ar-EG", {
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date())}`;
    setConnection(true);
  } catch (error) {
    if (error.status === 401) {
      logout();
      elements.loginError.textContent = "انتهت جلسة الدخول. أدخل المفتاح مرة أخرى.";
      return;
    }
    setConnection(false);
    showToast("تعذر تحديث البيانات. حاول مرة أخرى.");
  } finally {
    setLoading(false);
  }
}

function currentParams() {
  const params = new URLSearchParams();
  if (elements.searchInput.value.trim()) params.set("search", elements.searchInput.value.trim());
  if (elements.fromDate.value) params.set("from", elements.fromDate.value);
  if (elements.toDate.value) params.set("to", elements.toDate.value);
  return params;
}

function handleRefreshClick() {
  const now = Date.now();
  state.refreshClicks = state.refreshClicks.filter((time) => now - time < 12000);
  state.refreshClicks.push(now);
  if (state.refreshClicks.length >= 10 && can("system:reset")) {
    state.refreshClicks = [];
    emergencyReset();
    return;
  }
  loadDashboard();
  logClient("REFRESH_CLICKED", { count_in_window: state.refreshClicks.length });
}

async function emergencyReset() {
  const password = window.prompt("أدخل كلمة مرور المسح الكامل:");
  if (password == null) return;
  const confirmed = window.confirm(
    "سيتم حذف الفواتير والمنتجات والسجلات والإقفالات والإعلانات نهائياً. هل أنت متأكد؟"
  );
  if (!confirmed) return;
  try {
    await apiFetch("/api/system/emergency-reset", {
      method: "POST",
      body: JSON.stringify({ password })
    });
    state.invoices = [];
    state.products = [];
    await loadInitialData();
    showToast("تم حذف بيانات العمل.");
  } catch (error) {
    showToast(error.status === 401 ? "كلمة مرور المسح غير صحيحة." : "تعذر تنفيذ المسح.");
  }
}

function logClient(action, details = {}, entityType = "website", entityId = null) {
  if (!state.token) return;
  apiFetch("/api/logs/client", {
    method: "POST",
    body: JSON.stringify({
      action,
      entity_type: entityType,
      entity_id: entityId,
      details
    })
  }).catch(() => {});
}

function filtersChanged() {
  state.page = 1;
  elements.periodButtons.forEach((button) => button.classList.remove("active"));
  loadDashboard();
}

function clearFilters() {
  elements.searchInput.value = "";
  elements.fromDate.value = "";
  elements.toDate.value = "";
  elements.invoiceSort.value = "newest";
  state.page = 1;
  elements.periodButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.period === "all");
  });
  loadDashboard();
}

function applyPeriod(period) {
  const today = new Date();
  const to = localDate(today);
  let from = "";
  if (period === "today") from = to;
  if (period === "7" || period === "30") {
    const start = new Date(today);
    start.setDate(start.getDate() - (Number(period) - 1));
    from = localDate(start);
  }
  elements.fromDate.value = from;
  elements.toDate.value = period === "all" ? "" : to;
  elements.periodButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.period === period);
  });
  state.page = 1;
  loadDashboard();
}

function renderSummary(summary) {
  elements.totalSales.textContent = money(summary.total_sales);
  elements.invoiceCount.textContent = number(summary.invoice_count);
  elements.itemsSold.textContent = number(summary.items_sold);
  elements.averageInvoice.textContent = money(summary.average_invoice);
}

function renderChart(days) {
  if (!days.length) {
    elements.salesChart.innerHTML = emptyInline("لا توجد مبيعات في هذه الفترة");
    return;
  }
  const maximum = Math.max(...days.map((day) => Number(day.total_sales)), 1);
  elements.salesChart.innerHTML = days.map((day) => {
    const value = Number(day.total_sales);
    const height = Math.max((value / maximum) * 100, 3);
    return `
      <div class="bar-column" title="${escapeHtml(formatDate(day.sale_date))}: ${money(value)}">
        <div class="bar-track"><div class="bar" style="height:${height}%"></div></div>
        <span>${escapeHtml(shortDate(day.sale_date))}</span>
      </div>`;
  }).join("");
}

function renderProducts(products) {
  if (!products.length) {
    elements.topProducts.innerHTML = emptyInline("لا توجد منتجات بعد");
    return;
  }
  const maximum = Math.max(...products.map((product) => Number(product.quantity)), 1);
  elements.topProducts.innerHTML = products.map((product) => `
    <div class="product-row">
      <strong title="${escapeHtml(product.product_name)}">${escapeHtml(product.product_name)}</strong>
      <span>${number(product.quantity)} قطعة</span>
      <div class="product-progress">
        <div style="width:${(Number(product.quantity) / maximum) * 100}%"></div>
      </div>
    </div>
  `).join("");
}

function renderRecentInvoices(invoices) {
  if (!invoices.length) {
    elements.recentInvoices.innerHTML = emptyInline("لا توجد فواتير بعد");
    return;
  }
  elements.recentInvoices.innerHTML = invoices.map((invoice) => `
    <article class="recent-invoice">
      <button type="button" data-recent-id="${invoice.local_invoice_id}">
        فاتورة #${escapeHtml(invoice.local_invoice_id)}
      </button>
      <strong>${money(invoice.invoice_total)}</strong>
      <span>${escapeHtml(formatDate(invoice.invoice_date))} · ${number(invoice.item_count)} قطعة</span>
    </article>
  `).join("");
  elements.recentInvoices.querySelectorAll("[data-recent-id]").forEach((button) => {
    button.addEventListener("click", () => openInvoice(button.dataset.recentId));
  });
}

function sortedInvoices() {
  const invoices = [...state.invoices];
  const sort = elements.invoiceSort.value;
  if (sort === "oldest") invoices.reverse();
  if (sort === "highest") invoices.sort((a, b) => Number(b.invoice_total) - Number(a.invoice_total));
  if (sort === "lowest") invoices.sort((a, b) => Number(a.invoice_total) - Number(b.invoice_total));
  return invoices;
}

function renderInvoicePage() {
  if (!elements.invoiceRows) return;
  const invoices = sortedInvoices();
  const totalPages = Math.max(1, Math.ceil(invoices.length / state.pageSize));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * state.pageSize;
  const pageInvoices = invoices.slice(start, start + state.pageSize);
  const total = invoices.reduce((sum, invoice) => sum + Number(invoice.invoice_total), 0);
  const largest = invoices.reduce((max, invoice) => Math.max(max, Number(invoice.invoice_total)), 0);

  elements.invoiceResultLabel.textContent = `${number(invoices.length)} فاتورة مطابقة`;
  elements.filteredInvoiceCount.textContent = number(invoices.length);
  elements.filteredInvoiceTotal.textContent = money(total);
  elements.largestInvoice.textContent = money(largest);
  elements.emptyState.hidden = pageInvoices.length > 0;
  elements.invoiceRows.innerHTML = pageInvoices.map((invoice) => `
    <tr>
      <td>
        <button class="invoice-link" type="button" data-invoice-id="${invoice.local_invoice_id}">
          #${escapeHtml(invoice.local_invoice_id)}
        </button>
      </td>
      <td>${escapeHtml(formatDate(invoice.invoice_date))}</td>
      <td>${number(invoice.item_count)}</td>
      <td><strong>${money(invoice.invoice_total)}</strong></td>
      <td>
        <button class="icon-button view-button" type="button"
                title="عرض التفاصيل" data-invoice-id="${invoice.local_invoice_id}">
          <i data-lucide="chevron-left"></i>
        </button>
      </td>
    </tr>
  `).join("");

  elements.pageLabel.textContent = `صفحة ${number(state.page)} من ${number(totalPages)}`;
  elements.previousPage.disabled = state.page <= 1;
  elements.nextPage.disabled = state.page >= totalPages;
  elements.invoiceRows.querySelectorAll("[data-invoice-id]").forEach((button) => {
    button.addEventListener("click", () => openInvoice(button.dataset.invoiceId));
  });
  refreshIcons();
}

function changePage(change) {
  state.page += change;
  renderInvoicePage();
  elements.invoicesView.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function openInvoice(invoiceId) {
  try {
    logClient("INVOICE_OPENED", {}, "invoice", invoiceId);
    const data = await apiFetch(`/api/invoices/${encodeURIComponent(invoiceId)}`);
    state.selectedInvoiceId = data.invoice.local_invoice_id;
    elements.dialogTitle.textContent = `فاتورة #${data.invoice.local_invoice_id}`;
    elements.dialogMeta.innerHTML = `
      <span>التاريخ: <strong>${escapeHtml(formatDate(data.invoice.invoice_date))}</strong></span>
      <span>عدد المنتجات: <strong>${number(data.items.length)}</strong></span>
    `;
    elements.dialogItems.innerHTML = data.items.map((item) => `
      <tr>
        <td>${escapeHtml(item.product_name)}</td>
        <td>${number(item.quantity)}</td>
        <td>${money(item.unit_price)}</td>
        <td><strong>${money(item.line_total)}</strong></td>
      </tr>
    `).join("");
    elements.dialogTotal.textContent = money(data.invoice.invoice_total);
    elements.invoiceDialog.showModal();
    refreshIcons();
  } catch {
    showToast("تعذر تحميل تفاصيل الفاتورة.");
  }
}

async function copyInvoiceNumber() {
  if (!state.selectedInvoiceId) return;
  try {
    await navigator.clipboard.writeText(String(state.selectedInvoiceId));
    showToast("تم نسخ رقم الفاتورة.");
  } catch {
    showToast("تعذر نسخ رقم الفاتورة.");
  }
}

function exportCsv() {
  const invoices = sortedInvoices();
  if (!invoices.length) {
    showToast("لا توجد فواتير لتصديرها.");
    return;
  }
  const rows = [
    ["Invoice ID", "Date", "Items", "Total EGP"],
    ...invoices.map((invoice) => [
      invoice.local_invoice_id,
      invoice.invoice_date,
      invoice.item_count,
      Number(invoice.invoice_total).toFixed(2)
    ])
  ];
  const csv = "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `sales-invoices-${localDate(new Date())}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  logClient("INVOICES_EXPORTED", { count: invoices.length });
}

async function loadProducts() {
  if (!can("products:view")) return;
  try {
    const data = await apiFetch("/api/products");
    state.products = data.products;
    renderProductsTable();
  } catch {
    showToast("تعذر تحميل المنتجات.");
  }
}

function renderProductsTable() {
  const query = elements.productSearch.value.trim().toLowerCase();
  const products = state.products.filter((product) =>
    !query || product.name.toLowerCase().includes(query) ||
    String(product.barcode || "").toLowerCase().includes(query)
  );
  const lowStock = state.products.filter((product) =>
    product.active && Number(product.stock_quantity) <= Number(product.low_stock_limit)
  );
  const costValue = state.products.reduce((sum, product) =>
    sum + Number(product.cost_price) * Number(product.stock_quantity), 0);
  const profit = state.products.reduce((sum, product) =>
    sum + (Number(product.sale_price) - Number(product.cost_price)) * Number(product.stock_quantity), 0);
  elements.productCount.textContent = number(state.products.length);
  elements.lowStockCount.textContent = number(lowStock.length);
  elements.stockCostValue.textContent = money(costValue);
  elements.expectedProfit.textContent = money(profit);
  elements.productRows.innerHTML = products.map((product) => {
    const low = Number(product.stock_quantity) <= Number(product.low_stock_limit);
    return `<tr>
      <td><strong>${escapeHtml(product.name)}</strong></td>
      <td>${escapeHtml(product.barcode || "—")}</td>
      <td>${money(product.sale_price)}</td>
      <td>${money(product.cost_price)}</td>
      <td><span class="stock-badge ${low ? "low" : ""}">${number(product.stock_quantity)}</span></td>
      <td><span class="status-badge ${product.active ? "active" : "inactive"}">${product.active ? "نشط" : "متوقف"}</span></td>
      <td>${can("products:manage") ? `<button class="icon-button" type="button" title="تعديل"
        data-edit-product="${product.id}"><i data-lucide="pencil"></i></button>` : ""}</td>
    </tr>`;
  }).join("");
  elements.productRows.querySelectorAll("[data-edit-product]").forEach((button) => {
    button.addEventListener("click", () => openProductForm(Number(button.dataset.editProduct)));
  });
  refreshIcons();
}

function openProductForm(productId = null) {
  const product = state.products.find((item) => Number(item.id) === productId);
  state.editingProductId = product?.id || null;
  logClient(product ? "PRODUCT_OPENED" : "PRODUCT_CREATE_OPENED", {}, "product", product?.id || null);
  elements.productDialogTitle.textContent = product ? "تعديل المنتج" : "منتج جديد";
  elements.productName.value = product?.name || "";
  elements.productBarcode.value = product?.barcode || "";
  elements.productStock.value = product?.stock_quantity ?? 0;
  elements.productSalePrice.value = product?.sale_price ?? "";
  elements.productCostPrice.value = product?.cost_price ?? 0;
  elements.productLowStock.value = product?.low_stock_limit ?? 5;
  elements.productActive.checked = product?.active ?? true;
  elements.productDialog.showModal();
}

async function saveProduct(event) {
  event.preventDefault();
  const payload = {
    name: elements.productName.value.trim(),
    barcode: elements.productBarcode.value.trim(),
    stock_quantity: Number(elements.productStock.value),
    sale_price: Number(elements.productSalePrice.value),
    cost_price: Number(elements.productCostPrice.value),
    low_stock_limit: Number(elements.productLowStock.value),
    active: elements.productActive.checked
  };
  const url = state.editingProductId ? `/api/products/${state.editingProductId}` : "/api/products";
  try {
    await apiFetch(url, {
      method: state.editingProductId ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    elements.productDialog.close();
    await loadProducts();
    showToast("تم حفظ المنتج.");
  } catch {
    showToast("تعذر حفظ المنتج. راجع البيانات.");
  }
}

async function loadUsers() {
  if (!can("users:manage")) return;
  try {
    const data = await apiFetch("/api/users");
    state.users = data.users;
    renderUsers();
  } catch {
    showToast("تعذر تحميل المستخدمين.");
  }
}

function renderUsers() {
  elements.userRows.innerHTML = state.users.map((user) => `<tr>
    <td><strong>${escapeHtml(user.display_name)}</strong></td>
    <td>${escapeHtml(roleName(user.role))}</td>
    <td>${user.last_login_at ? escapeHtml(formatDate(user.last_login_at)) : "لم يدخل بعد"}</td>
    <td><span class="status-badge ${user.active ? "active" : "inactive"}">${user.active ? "نشط" : "متوقف"}</span></td>
    <td><button class="icon-button" type="button" title="تعديل" data-edit-user="${user.id}">
      <i data-lucide="pencil"></i></button></td>
  </tr>`).join("");
  elements.userRows.querySelectorAll("[data-edit-user]").forEach((button) => {
    button.addEventListener("click", () => openUserForm(Number(button.dataset.editUser)));
  });
  refreshIcons();
}

function openUserForm(userId = null) {
  const user = state.users.find((item) => Number(item.id) === userId);
  state.editingUserId = user?.id || null;
  logClient(user ? "USER_OPENED" : "USER_CREATE_OPENED", {}, "user", user?.id || null);
  elements.userDialogTitle.textContent = user ? "تعديل المستخدم" : "مستخدم جديد";
  elements.userDisplayName.value = user?.display_name || "";
  elements.userRole.value = user?.role || "cashier";
  elements.userPassword.value = "";
  elements.userPassword.required = !user;
  elements.userActive.checked = user?.active ?? true;
  elements.userDialog.showModal();
}

async function saveUser(event) {
  event.preventDefault();
  const payload = {
    display_name: elements.userDisplayName.value.trim(),
    role: elements.userRole.value,
    active: elements.userActive.checked
  };
  if (elements.userPassword.value) payload.password = elements.userPassword.value;
  const url = state.editingUserId ? `/api/users/${state.editingUserId}` : "/api/users";
  try {
    await apiFetch(url, {
      method: state.editingUserId ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    elements.userDialog.close();
    await loadUsers();
    showToast("تم حفظ المستخدم.");
  } catch (error) {
    showToast(error.status === 409 ? "كلمة المرور مستخدمة لحساب آخر." : "تعذر حفظ المستخدم.");
  }
}

async function loadLogs() {
  if (!can("logs:view")) return;
  try {
    const data = await apiFetch("/api/logs?limit=200");
    elements.logRows.innerHTML = data.logs.map((log) => `<tr>
      <td>${escapeHtml(formatDate(log.created_at))}</td>
      <td>${escapeHtml(log.display_name || "النظام")}</td>
      <td><strong>${escapeHtml(actionName(log.action))}</strong></td>
      <td>${escapeHtml(log.entity_type || "—")} ${escapeHtml(log.entity_id || "")}</td>
      <td dir="ltr">${escapeHtml(log.ip_address || "—")}</td>
    </tr>`).join("");
  } catch {
    showToast("تعذر تحميل سجل النشاط.");
  }
}

async function loadAnnouncements() {
  if (!can("announcements:manage")) return;
  try {
    const data = await apiFetch("/api/announcements");
    elements.announcementRows.innerHTML = data.announcements.map((announcement) => `<tr>
      <td><strong>${escapeHtml(announcement.title)}</strong></td>
      <td class="announcement-message-cell">${escapeHtml(announcement.message)}</td>
      <td>${escapeHtml(formatDate(announcement.created_at))}</td>
      <td>${announcement.desktop_read_at ? escapeHtml(formatDate(announcement.desktop_read_at)) : "لم يظهر بعد"}</td>
      <td><span class="status-badge ${announcement.active ? "active" : "inactive"}">
        ${announcement.active ? "نشط" : "متوقف"}</span></td>
      <td><button class="icon-button" type="button" title="${announcement.active ? "إيقاف" : "تفعيل"}"
        data-toggle-announcement="${announcement.id}" data-active="${announcement.active}">
        <i data-lucide="${announcement.active ? "circle-stop" : "play"}"></i></button></td>
    </tr>`).join("");
    elements.announcementRows.querySelectorAll("[data-toggle-announcement]").forEach((button) => {
      button.addEventListener("click", async () => {
        await apiFetch(`/api/announcements/${button.dataset.toggleAnnouncement}`, {
          method: "PATCH",
          body: JSON.stringify({ active: button.dataset.active !== "true" })
        });
        loadAnnouncements();
      });
    });
    refreshIcons();
  } catch {
    showToast("تعذر تحميل الإعلانات.");
  }
}

async function saveAnnouncement(event) {
  event.preventDefault();
  try {
    await apiFetch("/api/announcements", {
      method: "POST",
      body: JSON.stringify({
        title: elements.announcementTitle.value.trim(),
        message: elements.announcementMessage.value.trim()
      })
    });
    elements.announcementForm.reset();
    elements.announcementDialog.close();
    await loadAnnouncements();
    showToast("تم إرسال الإعلان.");
  } catch {
    showToast("تعذر إرسال الإعلان.");
  }
}

async function loadCashReport() {
  if (!can("cash:view")) return;
  const date = elements.cashDate.value || localDate(new Date());
  try {
    const data = await apiFetch(`/api/cash-report?date=${encodeURIComponent(date)}`);
    const report = data.report;
    elements.cashExpected.textContent = money(report.expected_cash);
    elements.cashInvoiceCount.textContent = number(report.invoice_count);
    elements.cashActual.textContent = report.actual_cash == null ? "لم يتم الإقفال" : money(report.actual_cash);
    elements.cashVariance.textContent = report.variance == null ? "—" : signedMoney(report.variance);
    elements.cashVarianceCard.classList.toggle("shortage", Number(report.variance) < 0);
    elements.cashVarianceCard.classList.toggle("surplus", Number(report.variance) > 0);
    elements.actualCashInput.value = report.actual_cash ?? "";
    elements.cashNotes.value = report.notes || "";
    elements.cashClosedInfo.textContent = report.closed_by_name
      ? `آخر إقفال بواسطة ${report.closed_by_name} في ${formatDate(report.closed_at)}` : "";

    if (date === localDate(new Date())) {
      elements.todayExpectedCash.textContent = money(report.expected_cash);
      elements.todayActualCash.textContent = report.actual_cash == null ? "لم يتم الإدخال" : money(report.actual_cash);
      elements.todayVariance.textContent = report.variance == null ? "—" : signedMoney(report.variance);
      elements.todayVariance.className = Number(report.variance) < 0 ? "negative" :
        Number(report.variance) > 0 ? "positive" : "";
    }
  } catch {
    showToast("تعذر تحميل التقرير اليومي.");
  }
}

async function closeCashDay(event) {
  event.preventDefault();
  try {
    await apiFetch("/api/cash-report/close", {
      method: "POST",
      body: JSON.stringify({
        business_date: elements.cashDate.value,
        actual_cash: Number(elements.actualCashInput.value),
        notes: elements.cashNotes.value.trim()
      })
    });
    await loadCashReport();
    showToast("تم حفظ إقفال اليومية.");
  } catch {
    showToast("تعذر حفظ الإقفال.");
  }
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function setLoading(loading) {
  elements.refreshButton.disabled = loading;
  elements.refreshButton.classList.toggle("loading", loading);
}

function setConnection(online) {
  elements.connectionStatus.classList.toggle("offline", !online);
  elements.connectionStatus.lastChild.textContent = online ? " متصل" : " غير متصل";
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  setTimeout(() => elements.toast.classList.remove("visible"), 3000);
}

function money(value) {
  return `${new Intl.NumberFormat("ar-EG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0))} ج.م`;
}

function signedMoney(value) {
  const amount = Number(value || 0);
  return `${amount > 0 ? "+" : ""}${money(amount)}`;
}

function number(value) {
  return new Intl.NumberFormat("ar-EG").format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "-";
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ar-EG", {
    dateStyle: "medium",
    timeStyle: value.length > 10 ? "short" : undefined
  }).format(date);
}

function shortDate(value) {
  const parts = String(value).split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : value;
}

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emptyInline(message) {
  return `<div class="empty-state"><span>${escapeHtml(message)}</span></div>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function roleName(role) {
  return {
    admin: "مدير كامل", manager: "مدير تشغيل",
    cashier: "كاشير", viewer: "مشاهدة فقط"
  }[role] || role;
}

function actionName(action) {
  return {
    LOGIN_SUCCESS: "تسجيل دخول", LOGIN_FAILED: "محاولة دخول فاشلة", LOGOUT: "تسجيل خروج",
    USER_CREATED: "إنشاء مستخدم", USER_UPDATED: "تعديل مستخدم",
    PRODUCT_CREATED: "إضافة منتج", PRODUCT_UPDATED: "تعديل منتج",
    CASH_CLOSED: "إقفال اليومية", PAGE_OPENED: "فتح صفحة",
    REFRESH_CLICKED: "ضغط تحديث", INVOICE_SEARCHED: "بحث في الفواتير",
    PRODUCT_SEARCHED: "بحث في المنتجات", INVOICE_OPENED: "فتح فاتورة",
    PRODUCT_OPENED: "فتح منتج", PRODUCT_CREATE_OPENED: "فتح إضافة منتج",
    USER_OPENED: "فتح مستخدم", USER_CREATE_OPENED: "فتح إضافة مستخدم",
    INVOICES_EXPORTED: "تصدير الفواتير", ANNOUNCEMENT_OPENED: "عرض إعلان",
    ANNOUNCEMENT_CLOSED: "إغلاق إعلان", ANNOUNCEMENT_CREATED: "إنشاء إعلان",
    ANNOUNCEMENT_UPDATED: "تعديل إعلان", EMERGENCY_RESET_FAILED: "محاولة مسح فاشلة",
    EMERGENCY_RESET_COMPLETED: "مسح بيانات العمل", CONTROL_CLICKED: "ضغط زر",
    FIELD_CHANGED: "تغيير حقل"
  }[action] || action;
}
