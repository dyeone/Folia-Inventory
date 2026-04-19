import React, { useState, useEffect, useMemo, useRef, createContext, useContext } from 'react';
import { Package, Sprout, Plus, Search, Download, Upload, Trash2, Edit2, ArrowRightLeft, X, Check, TrendingUp, DollarSign, Archive, Calendar, Filter, AlertCircle, Layers, Tag, ListOrdered, FileCheck, Users, LogOut, Lock, UserPlus, Shield, User, Eye, EyeOff, Key, Printer } from 'lucide-react';
import * as XLSX from 'xlsx';
import JsBarcode from 'jsbarcode';
import { api } from './api.js';

const VARIETIES = ['Anthurium', 'Alocasia', 'Monstera', 'Jewel Orchid'];

const PRICE_BUCKETS = [
  { label: '$0 – 25', min: 0, max: 25 },
  { label: '$25 – 50', min: 25, max: 50 },
  { label: '$50 – 100', min: 50, max: 100 },
  { label: '$100 – 250', min: 100, max: 250 },
  { label: '$250 – 500', min: 250, max: 500 },
  { label: '$500+', min: 500, max: Infinity },
  { label: 'No price set', min: null, max: null },
];

const AuthContext = createContext(null);

export default function InventoryApp() {
  const [currentUser, setCurrentUser] = useState(null);
  const [loadingSession, setLoadingSession] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const stored = localStorage.getItem('session-current-user');
        if (stored) {
          const { id } = JSON.parse(stored);
          const user = await api.session(id);
          if (user) setCurrentUser(user);
        }
      } catch (e) {
        localStorage.removeItem('session-current-user');
      }
      setLoadingSession(false);
    })();
  }, []);

  const login = (user) => {
    setCurrentUser(user);
    localStorage.setItem('session-current-user', JSON.stringify({ id: user.id }));
  };

  const logout = () => {
    setCurrentUser(null);
    localStorage.removeItem('session-current-user');
  };

  if (loadingSession) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500 text-sm">Loading...</div>
      </div>
    );
  }

  if (!currentUser) {
    return <AuthScreen onLogin={login} />;
  }

  return (
    <AuthContext.Provider value={{ currentUser, logout, setCurrentUser }}>
      <InventorySystem />
    </AuthContext.Provider>
  );
}

function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [hasAnyUsers, setHasAnyUsers] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const hasUsers = await api.hasAnyUsers();
        setHasAnyUsers(hasUsers);
        if (!hasUsers) setMode('register');
      } catch (e) {
        setHasAnyUsers(false);
        setMode('register');
      }
    })();
  }, []);

  const handleSubmit = async () => {
    setErr('');
    if (!username.trim()) return setErr('Username required');
    if (!password) return setErr('Password required');

    setLoading(true);
    try {
      if (mode === 'register') {
        if (password.length < 6) {
          setErr('Password must be at least 6 characters');
          setLoading(false);
          return;
        }
        if (password !== confirmPassword) {
          setErr('Passwords do not match');
          setLoading(false);
          return;
        }
        const user = await api.register({
          username: username.trim(),
          password,
          displayName: displayName.trim() || username.trim(),
        });
        onLogin(user);
      } else {
        const user = await api.login({ username: username.trim(), password });
        onLogin(user);
      }
    } catch (e) {
      setErr(e.message || 'Sign-in failed. Please try again.');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-sky-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="bg-[#d4e9c7] px-6 py-6">
          <img src="/logo.png" alt="Folia Society" className="h-16 w-auto mx-auto block mb-3" />
          <p className="text-center text-sm text-[#2d3f5e]">
            {mode === 'register'
              ? (hasAnyUsers === false ? 'Create the first admin account' : 'Register a new staff account')
              : 'Sign in to continue'}
          </p>
        </div>

        <div className="p-6 space-y-3">
          {hasAnyUsers === false && mode === 'register' && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs text-emerald-800">
              You're the first user — you'll be set up as the Admin.
            </div>
          )}

          <Field label="Username">
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              className="input"
              autoComplete="username"
              placeholder="yourname"
            />
          </Field>

          {mode === 'register' && (
            <Field label="Display Name (optional)">
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="input"
                placeholder="How you'll appear to teammates"
              />
            </Field>
          )}

          <Field label="Password">
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                className="input pr-10"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder={mode === 'register' ? 'At least 6 characters' : ''}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-gray-400 hover:text-gray-600"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </Field>

          {mode === 'register' && (
            <Field label="Confirm Password">
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                className="input"
                autoComplete="new-password"
              />
            </Field>
          )}

          {err && (
            <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
              <AlertCircle className="w-4 h-4 flex-shrink-0" /> {err}
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={loading}
            className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white text-sm font-medium rounded-lg transition flex items-center justify-center gap-2"
          >
            {loading ? 'Please wait...' : (mode === 'register' ? <><UserPlus className="w-4 h-4" /> Create Account</> : <><Lock className="w-4 h-4" /> Sign In</>)}
          </button>

          {hasAnyUsers !== false && (
            <div className="text-center text-xs text-gray-500 pt-2 border-t border-gray-100">
              {mode === 'login' ? (
                <>Need an account? <button onClick={() => { setMode('register'); setErr(''); }} className="text-emerald-600 hover:text-emerald-700 font-medium">Register</button></>
              ) : (
                <>Already have an account? <button onClick={() => { setMode('login'); setErr(''); }} className="text-emerald-600 hover:text-emerald-700 font-medium">Sign In</button></>
              )}
            </div>
          )}
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </div>
  );
}

function InventorySystem() {
  const { currentUser, logout } = useContext(AuthContext);
  const isAdmin = currentUser.role === 'admin';

  const [activeTab, setActiveTab] = useState('dashboard');
  const [items, setItems] = useState([]);
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [showConvertModal, setShowConvertModal] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showSaleModal, setShowSaleModal] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showLineupBuilder, setShowLineupBuilder] = useState(false);
  const [lineupSale, setLineupSale] = useState(null);
  const [showReconcile, setShowReconcile] = useState(false);
  const [reconcileSale, setReconcileSale] = useState(null);
  const [editingItem, setEditingItem] = useState(null);
  const [convertingItem, setConvertingItem] = useState(null);
  const [assigningItem, setAssigningItem] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterSale, setFilterSale] = useState('all');
  const [toast, setToast] = useState(null);
  const [labelItems, setLabelItems] = useState(null); // array of items to show in LabelSheet, or null

  useEffect(() => {
    (async () => {
      try {
        const [itemsData, salesData] = await Promise.all([api.getItems(), api.getSales()]);
        const sortByCreated = (arr) =>
          [...arr].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        setItems(sortByCreated(itemsData));
        setSales(sortByCreated(salesData));
      } catch (e) {
        showToast(e.message || 'Failed to load data', 'error');
      }
      setLoading(false);
    })();
  }, []);

  // Diff two item arrays and return only the rows that were added or changed.
  // A shallow JSON compare is good enough here because item objects have
  // stable shapes coming from the DB.
  const diffChanged = (newArr, oldArr) => {
    const oldMap = new Map(oldArr.map(x => [x.id, JSON.stringify(x)]));
    return newArr.filter(x => oldMap.get(x.id) !== JSON.stringify(x));
  };

  const saveItems = async (newItems) => {
    const oldItems = items;
    setItems(newItems);
    try {
      const newIds = new Set(newItems.map(i => i.id));
      const deletedIds = oldItems.filter(i => !newIds.has(i.id)).map(i => i.id);
      const toUpsert = diffChanged(newItems, oldItems);
      const ops = [];
      if (toUpsert.length) ops.push(api.upsertItems(toUpsert));
      if (deletedIds.length) ops.push(api.deleteItems(deletedIds));
      if (ops.length) await Promise.all(ops);
    } catch (e) {
      showToast(e.message || 'Save failed', 'error');
    }
  };

  const saveSales = async (newSales) => {
    const oldSales = sales;
    setSales(newSales);
    try {
      const newIds = new Set(newSales.map(s => s.id));
      const deletedIds = oldSales.filter(s => !newIds.has(s.id)).map(s => s.id);
      const toUpsert = diffChanged(newSales, oldSales);
      const ops = [];
      if (toUpsert.length) ops.push(api.upsertSales(toUpsert));
      if (deletedIds.length) ops.push(api.deleteSales(deletedIds));
      if (ops.length) await Promise.all(ops);
    } catch (e) {
      showToast(e.message || 'Save failed', 'error');
    }
  };

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  };

  const addItem = (item) => {
    const newItem = {
      ...item,
      id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
      createdAt: new Date().toISOString(),
      createdBy: currentUser.displayName,
      status: item.status || 'available',
    };
    saveItems([newItem, ...items]);
    showToast(`Added ${item.sku}`);
    setLabelItems([newItem]);
  };

  const updateItem = (id, updates) => {
    saveItems(items.map(i => i.id === id ? {
      ...i,
      ...updates,
      modifiedAt: new Date().toISOString(),
      modifiedBy: currentUser.displayName,
    } : i));
    showToast('Updated');
  };

  const deleteItem = (id) => {
    if (!isAdmin) {
      showToast('Only admins can delete items', 'error');
      return;
    }
    const item = items.find(i => i.id === id);
    setConfirmDialog({
      title: 'Delete item?',
      message: `Permanently delete ${item?.sku || 'this item'}? This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        saveItems(items.filter(i => i.id !== id));
        showToast('Deleted');
      },
    });
  };

  const convertToPlant = (id, conversionData) => {
    const tc = items.find(i => i.id === id);
    if (!tc) return;
    const plant = {
      ...tc,
      ...conversionData,
      id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
      type: 'plant',
      convertedFromTcId: tc.id,
      convertedFromSku: tc.sku,
      convertedAt: new Date().toISOString(),
      convertedBy: currentUser.displayName,
      createdAt: new Date().toISOString(),
      status: 'available',
      saleId: null,
      lotNumber: null,
    };
    const updatedTc = { ...tc, status: 'converted', convertedToPlantId: plant.id };
    saveItems([plant, ...items.map(i => i.id === id ? updatedTc : i)]);
    showToast(`Converted ${tc.sku} → ${plant.sku}`);
  };

  const filteredItems = useMemo(() => {
    return items.filter(item => {
      if (filterType !== 'all' && item.type !== filterType) return false;
      if (filterStatus !== 'all' && item.status !== filterStatus) return false;
      if (filterSale !== 'all') {
        if (filterSale === 'none' && item.saleId) return false;
        if (filterSale !== 'none' && item.saleId !== filterSale) return false;
      }
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          item.sku?.toLowerCase().includes(q) ||
          item.name?.toLowerCase().includes(q) ||
          item.variety?.toLowerCase().includes(q) ||
          item.source?.toLowerCase().includes(q) ||
          item.notes?.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [items, searchQuery, filterType, filterStatus, filterSale]);

  const stats = useMemo(() => {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const allSold = items.filter(i => i.status === 'sold' || i.status === 'shipped' || i.status === 'delivered');
    const soldThisWeek = items.filter(i => ['sold','shipped','delivered'].includes(i.status) && i.soldAt && new Date(i.soldAt) >= weekAgo);
    const revenue = soldThisWeek.reduce((s, i) => s + (parseFloat(i.salePrice) || 0), 0);
    const available = items.filter(i => i.status === 'available');
    const avgPrice = soldThisWeek.length ? revenue / soldThisWeek.length : 0;

    // Profit calculations across all sold items (with cost data)
    const soldWithCost = allSold.filter(i => {
      const sp = parseFloat(i.salePrice);
      const cost = parseFloat(i.grossCost ?? i.cost);
      return !isNaN(sp) && sp > 0 && !isNaN(cost) && cost > 0;
    });
    let avgProfitRate = null;
    let totalProfit = 0;
    let totalRevenueAllTime = 0;
    let totalCostAllTime = 0;
    if (soldWithCost.length > 0) {
      const rates = soldWithCost.map(i => {
        const sp = parseFloat(i.salePrice);
        const cost = parseFloat(i.grossCost ?? i.cost);
        totalProfit += (sp - cost);
        totalRevenueAllTime += sp;
        totalCostAllTime += cost;
        return ((sp - cost) / cost) * 100;
      });
      avgProfitRate = rates.reduce((a, b) => a + b, 0) / rates.length;
    }

    // Profit this week
    const soldWeekWithCost = soldThisWeek.filter(i => {
      const sp = parseFloat(i.salePrice);
      const cost = parseFloat(i.grossCost ?? i.cost);
      return !isNaN(sp) && sp > 0 && !isNaN(cost) && cost > 0;
    });
    let avgProfitRateWeek = null;
    let profitThisWeek = 0;
    if (soldWeekWithCost.length > 0) {
      const rates = soldWeekWithCost.map(i => {
        const sp = parseFloat(i.salePrice);
        const cost = parseFloat(i.grossCost ?? i.cost);
        profitThisWeek += (sp - cost);
        return ((sp - cost) / cost) * 100;
      });
      avgProfitRateWeek = rates.reduce((a, b) => a + b, 0) / rates.length;
    }

    return {
      totalActive: available.length,
      tcCount: available.filter(i => i.type === 'tc').length,
      plantCount: available.filter(i => i.type === 'plant').length,
      soldThisWeek: soldThisWeek.length,
      revenueThisWeek: revenue,
      profitThisWeek,
      avgPrice,
      avgProfitRate,
      avgProfitRateWeek,
      totalSold: allSold.length,
      totalRevenueAllTime,
      totalProfit,
      soldWithCostCount: soldWithCost.length,
      listed: items.filter(i => i.status === 'listed').length,
      shipped: items.filter(i => i.status === 'shipped').length,
    };
  }, [items]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">Loading inventory...</div>
      </div>
    );
  }

  const tabs = [
    { id: 'dashboard', label: 'Dashboard', icon: TrendingUp },
    { id: 'inventory', label: 'Inventory', icon: Archive },
    { id: 'sales', label: 'Sales Events', icon: Calendar },
  ];
  if (isAdmin) tabs.push({ id: 'users', label: 'Users', icon: Users });

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="Folia Society" className="h-9 w-auto rounded-lg" />
            <h1 className="text-lg font-semibold text-gray-900">Folia Inventory</h1>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowBulkModal(true)} className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition">
              <Upload className="w-4 h-4" /> Import
            </button>
            <button onClick={() => setShowAddModal(true)} className="hidden md:flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition">
              <Plus className="w-4 h-4" /> Single
            </button>
            <button onClick={() => setShowBatchModal(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg transition">
              <Layers className="w-4 h-4" /><span className="hidden sm:inline">Add Variety</span>
            </button>
            <div className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center gap-1.5 px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition"
              >
                <div className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs font-semibold">
                  {currentUser.displayName?.[0]?.toUpperCase() || 'U'}
                </div>
                <span className="hidden sm:block">{currentUser.displayName}</span>
              </button>
              {showUserMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowUserMenu(false)} />
                  <div className="absolute right-0 mt-1 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-20">
                    <div className="px-3 py-2 border-b border-gray-100">
                      <div className="text-sm font-medium text-gray-900">{currentUser.displayName}</div>
                      <div className="text-xs text-gray-500 flex items-center gap-1 mt-0.5">
                        {isAdmin ? <Shield className="w-3 h-3" /> : <User className="w-3 h-3" />}
                        {isAdmin ? 'Admin' : 'Staff'} · @{currentUser.username}
                      </div>
                    </div>
                    <button
                      onClick={() => { setShowChangePassword(true); setShowUserMenu(false); }}
                      className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                    >
                      <Key className="w-4 h-4" /> Change Password
                    </button>
                    <button
                      onClick={() => { logout(); }}
                      className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                    >
                      <LogOut className="w-4 h-4" /> Sign Out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="hidden sm:flex max-w-7xl mx-auto px-4 gap-1 overflow-x-auto">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'border-emerald-600 text-emerald-700'
                    : 'border-transparent text-gray-600 hover:text-gray-900'
                }`}
              >
                <Icon className="w-4 h-4" /> {tab.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* Mobile bottom navigation */}
      <nav className="sm:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-gray-200 flex">
        {tabs.map(tab => {
          const Icon = tab.icon;
          const shortLabel = tab.id === 'sales' ? 'Sales' : tab.label;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium transition ${
                activeTab === tab.id ? 'text-emerald-700' : 'text-gray-500'
              }`}
            >
              <Icon className={`w-5 h-5 ${activeTab === tab.id ? 'text-emerald-600' : 'text-gray-400'}`} />
              {shortLabel}
            </button>
          );
        })}
      </nav>

      <main className="max-w-7xl mx-auto px-4 pt-4 pb-24 sm:py-6">
        {activeTab === 'dashboard' && <Dashboard stats={stats} items={items} sales={sales} />}
        {activeTab === 'inventory' && (
          <InventoryView
            items={filteredItems}
            allItems={items}
            sales={sales}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            filterType={filterType}
            setFilterType={setFilterType}
            filterStatus={filterStatus}
            setFilterStatus={setFilterStatus}
            filterSale={filterSale}
            setFilterSale={setFilterSale}
            onEdit={setEditingItem}
            onDelete={deleteItem}
            onConvert={(item) => { setConvertingItem(item); setShowConvertModal(true); }}
            onAssignSale={(item) => { setAssigningItem(item); setShowAssignModal(true); }}
            onPrintLabel={(item) => setLabelItems([item])}
            onStatusChange={(id, status) => {
              const updates = { status };
              if (status === 'sold') updates.soldAt = new Date().toISOString();
              updateItem(id, updates);
            }}
            isAdmin={isAdmin}
          />
        )}
        {activeTab === 'sales' && (
          <SalesView
            sales={sales}
            items={items}
            isAdmin={isAdmin}
            onCreate={() => setShowSaleModal(true)}
            onBuildLineup={(sale) => { setLineupSale(sale); setShowLineupBuilder(true); }}
            onReconcile={(sale) => { setReconcileSale(sale); setShowReconcile(true); }}
            onDelete={(id) => {
              if (!isAdmin) {
                showToast('Only admins can delete sale events', 'error');
                return;
              }
              const sale = sales.find(s => s.id === id);
              setConfirmDialog({
                title: 'Delete sale event?',
                message: `Delete "${sale?.name || 'this sale'}"? All items assigned will be unassigned from it (items themselves won't be deleted).`,
                confirmLabel: 'Delete',
                danger: true,
                onConfirm: () => {
                  saveSales(sales.filter(s => s.id !== id));
                  saveItems(items.map(i => i.saleId === id ? { ...i, saleId: null, lotNumber: null } : i));
                  showToast('Sale deleted');
                },
              });
            }}
          />
        )}
        {activeTab === 'users' && isAdmin && (
          <UsersView
            currentUser={currentUser}
            setConfirmDialog={setConfirmDialog}
            showToast={showToast}
          />
        )}
      </main>

      {showAddModal && (
        <ItemFormModal
          title="Add New SKU"
          sales={sales}
          existingItems={items}
          onSave={(data) => { addItem(data); setShowAddModal(false); }}
          onClose={() => setShowAddModal(false)}
        />
      )}
      {showBatchModal && (
        <BatchVarietyModal
          existingItems={items}
          onSave={(newItems) => {
            const stamped = newItems.map(i => ({
              ...i,
              id: Date.now().toString() + Math.random().toString(36).slice(2, 7) + Math.random().toString(36).slice(2, 5),
              createdAt: new Date().toISOString(),
              createdBy: currentUser.displayName,
              status: i.status || 'available',
            }));
            saveItems([...stamped, ...items]);
            showToast(`Added ${stamped.length} items`);
            setShowBatchModal(false);
            setLabelItems(stamped);
          }}
          onClose={() => setShowBatchModal(false)}
        />
      )}
      {editingItem && (
        <ItemFormModal
          title="Edit SKU"
          sales={sales}
          item={editingItem}
          onSave={(data) => { updateItem(editingItem.id, data); setEditingItem(null); }}
          onClose={() => setEditingItem(null)}
        />
      )}
      {showConvertModal && convertingItem && (
        <ConvertModal
          item={convertingItem}
          existingItems={items}
          onConvert={(data) => { convertToPlant(convertingItem.id, data); setShowConvertModal(false); setConvertingItem(null); }}
          onClose={() => { setShowConvertModal(false); setConvertingItem(null); }}
        />
      )}
      {showBulkModal && (
        <BulkImportModal
          onImport={(newItems) => {
            const stamped = newItems.map(i => ({
              ...i,
              id: Date.now().toString() + Math.random().toString(36).slice(2, 7) + Math.random().toString(36).slice(2, 5),
              createdAt: new Date().toISOString(),
              createdBy: currentUser.displayName,
              status: i.status || 'available',
            }));
            saveItems([...stamped, ...items]);
            showToast(`Imported ${stamped.length} items`);
            setShowBulkModal(false);
          }}
          onClose={() => setShowBulkModal(false)}
        />
      )}
      {showSaleModal && (
        <SaleFormModal
          onSave={(data) => {
            const newSale = {
              ...data,
              id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
              createdBy: currentUser.displayName,
              createdAt: new Date().toISOString(),
            };
            saveSales([newSale, ...sales]);
            showToast('Sale event created');
            setShowSaleModal(false);
          }}
          onClose={() => setShowSaleModal(false)}
        />
      )}
      {showAssignModal && assigningItem && (
        <AssignSaleModal
          item={assigningItem}
          sales={sales}
          items={items}
          onAssign={(saleId, lotNumber) => {
            updateItem(assigningItem.id, { saleId, lotNumber });
            setShowAssignModal(false);
            setAssigningItem(null);
          }}
          onClose={() => { setShowAssignModal(false); setAssigningItem(null); }}
        />
      )}
      {showLineupBuilder && lineupSale && (
        <LineupBuilder
          sale={lineupSale}
          items={items}
          onSave={(updates) => {
            const updateMap = new Map(updates.map(u => [u.id, u]));
            const newItems = items.map(i => {
              if (updateMap.has(i.id)) {
                const u = updateMap.get(i.id);
                return { ...i, saleId: u.saleId, lotNumber: u.lotNumber };
              }
              return i;
            });
            saveItems(newItems);
            showToast(`Lineup saved for ${lineupSale.name}`);
            setShowLineupBuilder(false);
            setLineupSale(null);
          }}
          onClose={() => { setShowLineupBuilder(false); setLineupSale(null); }}
        />
      )}
      {showReconcile && reconcileSale && (
        <ReconcileModal
          sale={reconcileSale}
          items={items}
          onApply={(updates) => {
            const updateMap = new Map(updates.map(u => [u.id, u]));
            const newItems = items.map(i => {
              if (updateMap.has(i.id)) {
                return { ...i, ...updateMap.get(i.id) };
              }
              return i;
            });
            saveItems(newItems);
            showToast(`Reconciled ${reconcileSale.name}`);
            setShowReconcile(false);
            setReconcileSale(null);
          }}
          onClose={() => { setShowReconcile(false); setReconcileSale(null); }}
        />
      )}
      {showChangePassword && (
        <ChangePasswordModal
          user={currentUser}
          onClose={() => setShowChangePassword(false)}
          onSuccess={() => {
            setShowChangePassword(false);
            showToast('Password changed');
          }}
        />
      )}

      {toast && (
        <div className={`fixed bottom-4 right-4 px-4 py-2 rounded-lg shadow-lg text-white text-sm z-50 ${
          toast.type === 'error' ? 'bg-red-600' : 'bg-gray-900'
        }`}>
          {toast.msg}
        </div>
      )}

      {confirmDialog && (
        <ConfirmDialog
          {...confirmDialog}
          onConfirm={() => { confirmDialog.onConfirm(); setConfirmDialog(null); }}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      {labelItems && labelItems.length > 0 && (
        <LabelSheet items={labelItems} onClose={() => setLabelItems(null)} />
      )}
    </div>
  );
}

function Label({ item }) {
  const svgRef = useRef(null);
  const sku = item.sku ? String(item.sku) : '';

  useEffect(() => {
    if (svgRef.current && sku) {
      try {
        JsBarcode(svgRef.current, sku, {
          format: 'CODE128',
          height: 30, // pixels drawn; width scales via SVG to fill the label
          margin: 0,
          displayValue: false, // SKU is shown separately above
        });
      } catch (e) {
        // ignore — invalid SKU characters leave the svg blank
      }
    }
  }, [sku]);

  // Sized to a standard 2" x 1" thermal label. This is both the on-screen
  // preview and the printed size.
  return (
    <div className="folia-label bg-white border border-gray-300 flex flex-col items-center justify-between text-center"
         style={{ width: '2in', height: '1in', padding: '0.08in', boxSizing: 'border-box' }}>
      <div className="text-[8pt] leading-tight text-gray-700 truncate w-full">
        {item.name}{item.variety ? ` · ${item.variety}` : ''}
      </div>
      <div className="font-mono font-bold text-gray-900 tracking-wider leading-none"
           style={{ fontSize: '14pt' }}>
        {sku}
      </div>
      <svg ref={svgRef} style={{ width: '1.8in', height: '0.35in' }} preserveAspectRatio="none" />
    </div>
  );
}

function LabelSheet({ items, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-gray-100 overflow-auto folia-label-sheet">
      <div className="folia-no-print sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900">
          Print labels <span className="text-gray-400 font-normal">· {items.length} {items.length === 1 ? 'item' : 'items'} · 2″ × 1″</span>
        </h2>
        <div className="ml-auto flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg hover:bg-gray-200 text-gray-700">
            Close
          </button>
          <button onClick={() => window.print()} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white">
            <Printer className="w-4 h-4" /> Print
          </button>
        </div>
      </div>
      <div className="p-4 flex flex-wrap gap-2 justify-center folia-label-grid">
        {items.map(item => <Label key={item.id} item={item} />)}
      </div>
      <style>{`
        @media print {
          .folia-no-print { display: none !important; }
          body > *:not(.folia-label-sheet) { display: none !important; }
          .folia-label-sheet {
            position: static !important;
            overflow: visible !important;
            background: white !important;
          }
          .folia-label-grid {
            display: flex !important;
            flex-wrap: wrap !important;
            gap: 0 !important;
            padding: 0 !important;
            justify-content: flex-start !important;
          }
          .folia-label {
            width: 2in !important;
            height: 1in !important;
            margin: 0 !important;
            border: 1px solid #666 !important;
            page-break-inside: avoid !important;
            break-inside: avoid !important;
          }
          /* Letter paper: 3 labels across × 10 down = 30 per page */
          @page { size: letter; margin: 0.25in; }
        }
      `}</style>
    </div>
  );
}

function Dashboard({ stats, items, sales }) {
  const recentSold = items
    .filter(i => ['sold','shipped','delivered'].includes(i.status))
    .sort((a, b) => new Date(b.soldAt || 0) - new Date(a.soldAt || 0))
    .slice(0, 5);

  // Top varieties by profit rate (for items with cost + sale price data)
  const varietyPerformance = useMemo(() => {
    const groups = {};
    items.forEach(i => {
      if (!['sold','shipped','delivered'].includes(i.status)) return;
      const sp = parseFloat(i.salePrice);
      const cost = parseFloat(i.grossCost ?? i.cost);
      if (isNaN(sp) || sp <= 0 || isNaN(cost) || cost <= 0) return;
      const key = [i.name, i.variety].filter(Boolean).join(' · ') || 'Unlabeled';
      if (!groups[key]) groups[key] = { revenue: 0, cost: 0, count: 0 };
      groups[key].revenue += sp;
      groups[key].cost += cost;
      groups[key].count += 1;
    });
    return Object.entries(groups)
      .map(([name, g]) => ({
        name,
        count: g.count,
        revenue: g.revenue,
        profit: g.revenue - g.cost,
        profitRate: ((g.revenue - g.cost) / g.cost) * 100,
      }))
      .sort((a, b) => b.profitRate - a.profitRate)
      .slice(0, 5);
  }, [items]);

  const formatRate = (r) => r === null || r === undefined ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(0)}%`;
  const rateColor = (r) => {
    if (r === null || r === undefined) return 'gray';
    if (r >= 200) return 'emerald';
    if (r >= 100) return 'blue';
    if (r >= 0) return 'amber';
    return 'red';
  };

  return (
    <div className="space-y-6">
      {/* Primary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Archive} label="Active SKUs" value={stats.totalActive} sub={`${stats.tcCount} TC · ${stats.plantCount} Plant`} color="emerald" />
        <StatCard icon={Package} label="Sold This Week" value={stats.soldThisWeek} sub={`${stats.totalSold} all-time`} color="blue" />
        <StatCard icon={DollarSign} label="Revenue / Week" value={`${stats.revenueThisWeek.toFixed(0)}`} sub={`Avg ${stats.avgPrice.toFixed(0)}/sale`} color="violet" />
        <StatCard icon={TrendingUp} label="Listed Now" value={stats.listed} sub={`${stats.shipped} shipped`} color="amber" />
      </div>

      {/* Profit stats */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 px-1">Profit Performance</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            icon={TrendingUp}
            label="Avg Profit Rate"
            value={formatRate(stats.avgProfitRate)}
            sub={stats.soldWithCostCount > 0 ? `Across ${stats.soldWithCostCount} sales` : 'No sales with cost data yet'}
            color={rateColor(stats.avgProfitRate)}
          />
          <StatCard
            icon={TrendingUp}
            label="Week Profit Rate"
            value={formatRate(stats.avgProfitRateWeek)}
            sub="This week's sales"
            color={rateColor(stats.avgProfitRateWeek)}
          />
          <StatCard
            icon={DollarSign}
            label="Profit This Week"
            value={`${stats.profitThisWeek.toFixed(0)}`}
            sub={`Revenue ${stats.revenueThisWeek.toFixed(0)}`}
            color="violet"
          />
          <StatCard
            icon={DollarSign}
            label="Profit All-Time"
            value={`${stats.totalProfit.toFixed(0)}`}
            sub={`Revenue ${stats.totalRevenueAllTime.toFixed(0)}`}
            color="emerald"
          />
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Recent Sales</h3>
          {recentSold.length === 0 ? (
            <p className="text-sm text-gray-500">No sales yet.</p>
          ) : (
            <div className="space-y-2">
              {recentSold.map(item => {
                const sp = parseFloat(item.salePrice);
                const cost = parseFloat(item.grossCost ?? item.cost);
                const hasProfit = !isNaN(sp) && sp > 0 && !isNaN(cost) && cost > 0;
                const rate = hasProfit ? ((sp - cost) / cost) * 100 : null;
                return (
                  <div key={item.id} className="flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-900 truncate">{item.name}{item.variety ? ` · ${item.variety}` : ''}</div>
                      <div className="text-xs text-gray-500">{item.sku}{item.buyer ? ` · ${item.buyer}` : ''}</div>
                    </div>
                    <div className="text-right ml-2">
                      <div className="text-sm font-medium text-emerald-700">${parseFloat(item.salePrice || 0).toFixed(2)}</div>
                      {hasProfit && (
                        <div className={`text-xs font-medium ${
                          rate >= 100 ? 'text-emerald-600' : rate >= 0 ? 'text-amber-600' : 'text-red-600'
                        }`}>
                          {formatRate(rate)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Top Varieties by Profit Rate</h3>
          {varietyPerformance.length === 0 ? (
            <p className="text-sm text-gray-500">No sales with cost data yet. Add gross cost to items to see profit analytics.</p>
          ) : (
            <div className="space-y-2">
              {varietyPerformance.map((v, idx) => (
                <div key={idx} className="flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 truncate">{v.name}</div>
                    <div className="text-xs text-gray-500">{v.count} sold · ${v.profit.toFixed(0)} profit</div>
                  </div>
                  <div className={`text-sm font-semibold ml-2 ${
                    v.profitRate >= 200 ? 'text-emerald-600' : v.profitRate >= 100 ? 'text-blue-600' : v.profitRate >= 0 ? 'text-amber-600' : 'text-red-600'
                  }`}>
                    {formatRate(v.profitRate)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Upcoming Sales</h3>
        {sales.length === 0 ? (
          <p className="text-sm text-gray-500">No sale events scheduled.</p>
        ) : (
          <div className="space-y-2">
            {sales.slice(0, 5).map(sale => {
              const count = items.filter(i => i.saleId === sale.id).length;
              return (
                <div key={sale.id} className="flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 truncate">{sale.name}</div>
                    <div className="text-xs text-gray-500">{sale.date}</div>
                  </div>
                  <div className="text-sm text-gray-600">{count} lots</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub, color }) {
  const colorMap = {
    emerald: 'bg-emerald-50 text-emerald-700',
    blue: 'bg-blue-50 text-blue-700',
    violet: 'bg-violet-50 text-violet-700',
    amber: 'bg-amber-50 text-amber-700',
    red: 'bg-red-50 text-red-700',
    gray: 'bg-gray-100 text-gray-600',
  };
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-600">{label}</span>
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${colorMap[color] || colorMap.gray}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function InventoryView({ items, allItems, sales, searchQuery, setSearchQuery, filterType, setFilterType, filterStatus, setFilterStatus, filterSale, setFilterSale, onEdit, onDelete, onConvert, onAssignSale, onPrintLabel, onStatusChange, isAdmin }) {
  const exportCSV = () => {
    const headers = ['SKU', 'Type', 'Name', 'Variety', 'Quantity', 'Cost', 'Listing Price', 'Sale Price', 'Status', 'Sale Event', 'Lot', 'Source', 'Acquired', 'Notes'];
    const rows = items.map(i => {
      const sale = sales.find(s => s.id === i.saleId);
      return [
        i.sku, i.type, i.name, i.variety || '', i.quantity || 1,
        i.cost || '', i.listingPrice || '', i.salePrice || '',
        i.status, sale?.name || '', i.lotNumber || '',
        i.source || '', i.acquiredAt || '', (i.notes || '').replace(/"/g, '""')
      ].map(v => `"${v}"`).join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 p-3 space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search SKU, name, variety..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
          </div>
          <button onClick={exportCSV} className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">
            <Download className="w-4 h-4" /> Export CSV
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <FilterPill label="Type" value={filterType} onChange={setFilterType} options={[
            { value: 'all', label: 'All types' },
            { value: 'tc', label: 'TC only' },
            { value: 'plant', label: 'Plant only' },
          ]} />
          <FilterPill label="Status" value={filterStatus} onChange={setFilterStatus} options={[
            { value: 'all', label: 'All statuses' },
            { value: 'available', label: 'Available' },
            { value: 'listed', label: 'Listed' },
            { value: 'sold', label: 'Sold' },
            { value: 'shipped', label: 'Shipped' },
            { value: 'delivered', label: 'Delivered' },
            { value: 'converted', label: 'Converted' },
          ]} />
          <FilterPill label="Sale" value={filterSale} onChange={setFilterSale} options={[
            { value: 'all', label: 'All sales' },
            { value: 'none', label: 'Unassigned' },
            ...sales.map(s => ({ value: s.id, label: s.name })),
          ]} />
        </div>
      </div>

      <div className="text-xs text-gray-500 px-1">
        Showing {items.length} of {allItems.length} items
      </div>

      {items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
          <Archive className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 text-sm">No items match your filters.</p>
        </div>
      ) : (
        <>
          {/* Mobile card list */}
          <div className="sm:hidden space-y-2">
            {items.map(item => {
              const sale = sales.find(s => s.id === item.saleId);
              const sp = parseFloat(item.salePrice);
              const cost = parseFloat(item.grossCost ?? item.cost);
              const isSold = ['sold','shipped','delivered'].includes(item.status);
              const profitRate = isSold && !isNaN(sp) && sp > 0 && !isNaN(cost) && cost > 0
                ? ((sp - cost) / cost) * 100 : null;
              return (
                <div key={item.id} className="bg-white rounded-xl border border-gray-200 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-gray-900 truncate">{item.name}</div>
                      <div className="text-xs text-gray-500 flex items-center gap-1.5 mt-0.5">
                        <span className="font-mono">{item.sku}</span>
                        {item.variety && <span>· {item.variety}</span>}
                      </div>
                    </div>
                    <span className={`flex-shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      item.type === 'tc' ? 'bg-sky-100 text-sky-700' : 'bg-emerald-100 text-emerald-700'
                    }`}>
                      {item.type === 'tc' ? 'TC' : 'Plant'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <select
                      value={item.status}
                      onChange={(e) => onStatusChange(item.id, e.target.value)}
                      className={`text-xs font-medium rounded px-2 py-1 border-0 focus:ring-2 focus:ring-emerald-500 ${
                        item.status === 'available' ? 'bg-gray-100 text-gray-700' :
                        item.status === 'listed' ? 'bg-amber-100 text-amber-800' :
                        item.status === 'sold' ? 'bg-blue-100 text-blue-800' :
                        item.status === 'shipped' ? 'bg-violet-100 text-violet-800' :
                        item.status === 'delivered' ? 'bg-emerald-100 text-emerald-800' :
                        'bg-gray-200 text-gray-600'
                      }`}
                    >
                      <option value="available">Available</option>
                      <option value="listed">Listed</option>
                      <option value="sold">Sold</option>
                      <option value="shipped">Shipped</option>
                      <option value="delivered">Delivered</option>
                      <option value="converted">Converted</option>
                    </select>
                    {sale ? (
                      <span className="text-xs text-gray-500 truncate">
                        {sale.name}{item.lotNumber && ` · Lot #${item.lotNumber}`}
                      </span>
                    ) : (
                      <button onClick={() => onAssignSale(item)} className="text-xs text-emerald-600 hover:text-emerald-700">
                        Assign sale
                      </button>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                      {profitRate !== null && (
                        <span className={`text-xs font-semibold mr-1 ${
                          profitRate >= 200 ? 'text-emerald-600' :
                          profitRate >= 100 ? 'text-blue-600' :
                          profitRate >= 0 ? 'text-amber-600' : 'text-red-600'
                        }`}>
                          {profitRate >= 0 ? '+' : ''}{profitRate.toFixed(0)}%
                        </span>
                      )}
                      {(item.status === 'sold' && item.salePrice) || item.listingPrice ? (
                        <span className="text-xs text-gray-700 mr-1">
                          ${parseFloat(item.status === 'sold' && item.salePrice ? item.salePrice : item.listingPrice).toFixed(2)}
                        </span>
                      ) : null}
                      {item.type === 'tc' && item.status !== 'converted' && (
                        <button onClick={() => onConvert(item)} title="Convert to plant" className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded">
                          <ArrowRightLeft className="w-4 h-4" />
                        </button>
                      )}
                      <button onClick={() => onPrintLabel(item)} title="Print label" className="p-1.5 text-gray-500 hover:bg-gray-100 rounded">
                        <Printer className="w-4 h-4" />
                      </button>
                      <button onClick={() => onEdit(item)} className="p-1.5 text-gray-500 hover:bg-gray-100 rounded">
                        <Edit2 className="w-4 h-4" />
                      </button>
                      {isAdmin && (
                        <button onClick={() => onDelete(item.id)} className="p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 rounded">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Desktop table */}
          <div className="hidden sm:block bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr className="text-left text-xs font-medium text-gray-600 uppercase tracking-wide">
                    <th className="px-3 py-2.5">SKU / Name</th>
                    <th className="px-3 py-2.5">Type</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Sale / Lot</th>
                    <th className="px-3 py-2.5 text-right">Price</th>
                    <th className="px-3 py-2.5 text-right">Profit</th>
                    <th className="px-3 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map(item => {
                    const sale = sales.find(s => s.id === item.saleId);
                    return (
                      <tr key={item.id} className="hover:bg-gray-50">
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-gray-900">{item.name}</div>
                          <div className="text-xs text-gray-500 flex items-center gap-1.5">
                            <span className="font-mono">{item.sku}</span>
                            {item.variety && <span>· {item.variety}</span>}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                            item.type === 'tc' ? 'bg-sky-100 text-sky-700' : 'bg-emerald-100 text-emerald-700'
                          }`}>
                            {item.type === 'tc' ? 'TC' : 'Plant'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <select
                            value={item.status}
                            onChange={(e) => onStatusChange(item.id, e.target.value)}
                            className={`text-xs font-medium rounded px-2 py-1 border-0 focus:ring-2 focus:ring-emerald-500 ${
                              item.status === 'available' ? 'bg-gray-100 text-gray-700' :
                              item.status === 'listed' ? 'bg-amber-100 text-amber-800' :
                              item.status === 'sold' ? 'bg-blue-100 text-blue-800' :
                              item.status === 'shipped' ? 'bg-violet-100 text-violet-800' :
                              item.status === 'delivered' ? 'bg-emerald-100 text-emerald-800' :
                              'bg-gray-200 text-gray-600'
                            }`}
                          >
                            <option value="available">Available</option>
                            <option value="listed">Listed</option>
                            <option value="sold">Sold</option>
                            <option value="shipped">Shipped</option>
                            <option value="delivered">Delivered</option>
                            <option value="converted">Converted</option>
                          </select>
                        </td>
                        <td className="px-3 py-2.5 text-xs">
                          {sale ? (
                            <div>
                              <div className="text-gray-900">{sale.name}</div>
                              {item.lotNumber && <div className="text-gray-500">Lot #{item.lotNumber}</div>}
                            </div>
                          ) : (
                            <button onClick={() => onAssignSale(item)} className="text-emerald-600 hover:text-emerald-700">
                              Assign
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right text-gray-900">
                          {item.status === 'sold' && item.salePrice ? `${parseFloat(item.salePrice).toFixed(2)}` :
                           item.listingPrice ? `${parseFloat(item.listingPrice).toFixed(2)}` : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {(() => {
                            const sp = parseFloat(item.salePrice);
                            const cost = parseFloat(item.grossCost ?? item.cost);
                            const isSold = ['sold','shipped','delivered'].includes(item.status);
                            if (!isSold || isNaN(sp) || sp <= 0 || isNaN(cost) || cost <= 0) return <span className="text-xs text-gray-400">—</span>;
                            const rate = ((sp - cost) / cost) * 100;
                            return (
                              <span className={`text-xs font-semibold ${
                                rate >= 200 ? 'text-emerald-600' :
                                rate >= 100 ? 'text-blue-600' :
                                rate >= 0 ? 'text-amber-600' :
                                'text-red-600'
                              }`}>
                                {rate >= 0 ? '+' : ''}{rate.toFixed(0)}%
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1 justify-end">
                            {item.type === 'tc' && item.status !== 'converted' && (
                              <button onClick={() => onConvert(item)} title="Convert to plant" className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded">
                                <ArrowRightLeft className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button onClick={() => onPrintLabel(item)} title="Print label" className="p-1.5 text-gray-500 hover:bg-gray-100 rounded">
                              <Printer className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => onEdit(item)} className="p-1.5 text-gray-500 hover:bg-gray-100 rounded">
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            {isAdmin && (
                              <button onClick={() => onDelete(item.id)} className="p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 rounded" title="Delete (admin only)">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FilterPill({ label, value, onChange, options }) {
  return (
    <div className="flex items-center gap-1.5 bg-gray-50 rounded-lg px-2 py-1">
      <Filter className="w-3.5 h-3.5 text-gray-400" />
      <span className="text-xs text-gray-600">{label}:</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="text-xs bg-transparent border-0 focus:outline-none text-gray-900 font-medium cursor-pointer">
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function SalesView({ sales, items, onCreate, onDelete, onBuildLineup, onReconcile, isAdmin }) {
  const exportPalmstreet = (sale) => {
    const saleItems = items
      .filter(i => i.saleId === sale.id)
      .sort((a, b) => {
        const la = parseInt(a.lotNumber) || 999999;
        const lb = parseInt(b.lotNumber) || 999999;
        return la - lb;
      });

    if (saleItems.length === 0) {
      alert('No lots in this sale yet. Click "Build Lineup" first to add items.');
      return;
    }

    const headers = [
      'Title (product name, 80 character max)*',
      'Item description*',
      'Image URL',
      'Price*',
      'Quantity* ',
      'Variation 1 name',
      'Variation 1 value ',
      'Variation 2 name',
      'Variation 2 value',
      'Variation 3 name',
      'Variation 3 value',
      'SKU',
      'Mark "Yes" for Private listing',
      'Shipping (Leave empty will follow store setting...)',
    ];

    const escape = (v) => {
      if (v === null || v === undefined || v === '') return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const buildTitle = (item) => {
      let t = item.name || '';
      if (item.variety) t = `${t} ${item.variety}`.trim();
      if (t.length > 80) t = t.slice(0, 80);
      return t;
    };

    const buildDescription = (item) => {
      const parts = [];
      if (item.name) parts.push(item.name);
      if (item.variety) parts.push(`Variety: ${item.variety}`);
      if (item.notes) parts.push(item.notes);
      return parts.join('. ');
    };

    const rows = saleItems.map(item => [
      buildTitle(item),
      buildDescription(item),
      item.imageUrl || '',
      parseFloat(item.listingPrice) || 0,
      parseInt(item.quantity) || 1,
      '', '',
      '', '',
      '', '',
      item.sku || '',
      '',
      '',
    ]);

    const csv = [
      headers.map(escape).join(','),
      ...rows.map(r => r.map(escape).join(',')),
    ].join('\n');

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = sale.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    a.href = url;
    a.download = `palmstreet-${safeName}-${sale.date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Sale Events</h2>
          <p className="text-xs text-gray-500 mt-0.5">Group SKUs into auction/sale days with lot numbers</p>
        </div>
        <button onClick={onCreate} className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg self-start sm:self-auto">
          <Plus className="w-4 h-4" /> New Sale Event
        </button>
      </div>

      {sales.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Calendar className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 text-sm">No sale events yet. Create one to organize your auction lineup.</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-3">
          {sales.map(sale => {
            const saleItems = items.filter(i => i.saleId === sale.id);
            const totalValue = saleItems.reduce((s, i) => s + (parseFloat(i.listingPrice) || 0), 0);
            return (
              <div key={sale.id} className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-gray-900 truncate">{sale.name}</div>
                    <div className="text-xs text-gray-500">{sale.date} · {sale.platform || 'Palmstreet'}</div>
                  </div>
                  {isAdmin && (
                    <button onClick={() => onDelete(sale.id)} className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete (admin only)">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">Lots assigned</div>
                    <div className="font-semibold text-gray-900">{saleItems.length}</div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">Listing total</div>
                    <div className="font-semibold text-gray-900">${totalValue.toFixed(0)}</div>
                  </div>
                </div>
                {sale.notes && <p className="text-xs text-gray-600 mb-3">{sale.notes}</p>}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => onBuildLineup(sale)}
                    className="flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-sm font-medium rounded-lg transition"
                  >
                    <Layers className="w-4 h-4" /> Build Lineup
                  </button>
                  <button
                    onClick={() => exportPalmstreet(sale)}
                    className="flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium rounded-lg transition"
                  >
                    <Download className="w-4 h-4" /> Export CSV
                  </button>
                </div>
                <button
                  onClick={() => {
                    if (saleItems.length === 0) {
                      alert('No lots in this sale yet. Click "Build Lineup" first.');
                      return;
                    }
                    onReconcile(sale);
                  }}
                  className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-amber-50 hover:bg-amber-100 text-amber-800 text-sm font-medium rounded-lg transition border border-amber-200"
                >
                  <FileCheck className="w-4 h-4" /> Reconcile Orders
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function UsersView({ currentUser, setConfirmDialog, showToast }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddUser, setShowAddUser] = useState(false);
  const [resetPasswordFor, setResetPasswordFor] = useState(null);

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      const data = await api.getUsers();
      setUsers(data);
    } catch (e) {
      showToast(e.message || 'Failed to load users', 'error');
    }
    setLoading(false);
  };

  const changeRole = async (userId, newRole) => {
    if (userId === currentUser.id) return showToast("You can't change your own role", 'error');
    try {
      await api.updateUser({ id: userId, patch: { role: newRole }, adminUserId: currentUser.id });
      setUsers(users.map(u => u.id === userId ? { ...u, role: newRole } : u));
      showToast('Role updated');
    } catch (e) {
      showToast(e.message || 'Failed to update role', 'error');
    }
  };

  const toggleActive = async (userId) => {
    if (userId === currentUser.id) return showToast("You can't deactivate your own account", 'error');
    const user = users.find(u => u.id === userId);
    try {
      await api.updateUser({ id: userId, patch: { active: !user.active }, adminUserId: currentUser.id });
      setUsers(users.map(u => u.id === userId ? { ...u, active: !u.active } : u));
      showToast(user.active ? 'User deactivated' : 'User activated');
    } catch (e) {
      showToast(e.message || 'Failed to update user', 'error');
    }
  };

  const deleteUser = (userId) => {
    if (userId === currentUser.id) return showToast("You can't delete your own account", 'error');
    const user = users.find(u => u.id === userId);
    setConfirmDialog({
      title: 'Delete user?',
      message: `Permanently delete "${user.displayName}" (@${user.username})? They'll lose all access. Items they created stay in the system.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        try {
          await api.deleteUsers([userId], currentUser.id);
          setUsers(users.filter(u => u.id !== userId));
          showToast('User deleted');
        } catch (e) {
          showToast(e.message || 'Failed to delete user', 'error');
        }
      },
    });
  };

  if (loading) {
    return <div className="text-sm text-gray-500">Loading users...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">User Management</h2>
          <p className="text-xs text-gray-500 mt-0.5">{users.length} {users.length === 1 ? 'user' : 'users'} total</p>
        </div>
        <button onClick={() => setShowAddUser(true)} className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg self-start sm:self-auto">
          <UserPlus className="w-4 h-4" /> Add User
        </button>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900">
        <strong>Note:</strong> User accounts and data are stored per-device. Team members will need to register on this same device/browser or share a sync method.
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr className="text-left text-xs font-medium text-gray-600 uppercase tracking-wide">
              <th className="px-3 py-2.5">User</th>
              <th className="px-3 py-2.5">Role</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Joined</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map(user => {
              const isSelf = user.id === currentUser.id;
              return (
                <tr key={user.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs font-semibold">
                        {user.displayName?.[0]?.toUpperCase() || 'U'}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 flex items-center gap-1.5">
                          {user.displayName}
                          {isSelf && <span className="text-xs text-gray-500">(you)</span>}
                        </div>
                        <div className="text-xs text-gray-500">@{user.username}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <select
                      value={user.role}
                      onChange={(e) => changeRole(user.id, e.target.value)}
                      disabled={isSelf}
                      className={`text-xs font-medium rounded px-2 py-1 border-0 focus:ring-2 focus:ring-emerald-500 ${
                        user.role === 'admin' ? 'bg-violet-100 text-violet-800' : 'bg-sky-100 text-sky-800'
                      } ${isSelf ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                      <option value="admin">Admin</option>
                      <option value="staff">Staff</option>
                    </select>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                      user.active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-200 text-gray-600'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${user.active ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                      {user.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-gray-600">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={() => setResetPasswordFor(user)}
                        title="Reset password"
                        className="p-1.5 text-gray-500 hover:bg-gray-100 rounded"
                      >
                        <Key className="w-3.5 h-3.5" />
                      </button>
                      {!isSelf && (
                        <>
                          <button
                            onClick={() => toggleActive(user.id)}
                            title={user.active ? 'Deactivate' : 'Activate'}
                            className="p-1.5 text-gray-500 hover:bg-gray-100 rounded"
                          >
                            {user.active ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            onClick={() => deleteUser(user.id)}
                            title="Delete user"
                            className="p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 rounded"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {showAddUser && (
        <AddUserModal
          existingUsers={users}
          onSave={async (fields) => {
            const newUser = await api.createUser({ ...fields, adminUserId: currentUser.id });
            setUsers([...users, newUser]);
            setShowAddUser(false);
            showToast(`Added ${newUser.displayName}`);
          }}
          onClose={() => setShowAddUser(false)}
        />
      )}

      {resetPasswordFor && (
        <ResetPasswordModal
          user={resetPasswordFor}
          onSave={async (newPassword) => {
            await api.updateUser({ id: resetPasswordFor.id, newPassword, adminUserId: currentUser.id });
            setResetPasswordFor(null);
            showToast('Password reset');
          }}
          onClose={() => setResetPasswordFor(null)}
        />
      )}
    </div>
  );
}

function AddUserModal({ existingUsers, onSave, onClose }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('staff');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    setErr('');
    if (!username.trim()) return setErr('Username required');
    if (password.length < 6) return setErr('Password must be at least 6 characters');
    const normalized = username.trim().toLowerCase();
    if (existingUsers.find(u => u.username === normalized)) return setErr('Username already taken');

    setLoading(true);
    try {
      await onSave({
        username: username.trim(),
        password,
        displayName: displayName.trim() || username.trim(),
        role,
      });
    } catch (e) {
      setErr(e.message || 'Failed to create user');
    }
    setLoading(false);
  };

  return (
    <Modal title="Add New User" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Username *">
          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} className="input" placeholder="username" />
        </Field>
        <Field label="Display Name">
          <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="input" placeholder="Full name" />
        </Field>
        <Field label="Initial Password *">
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} className="input" placeholder="At least 6 characters" />
        </Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value)} className="input">
            <option value="staff">Staff — view/edit inventory</option>
            <option value="admin">Admin — full access</option>
          </select>
        </Field>
        <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-2">
          Share the username and password with the new user. They should change it after first login.
        </div>
        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={handleSave} disabled={loading} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-lg">
            {loading ? 'Creating...' : 'Create User'}
          </button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}

function ResetPasswordModal({ user, onSave, onClose }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    setErr('');
    if (password.length < 6) return setErr('Password must be at least 6 characters');
    setLoading(true);
    try {
      await onSave(password);
    } catch (e) {
      setErr(e.message || 'Failed to reset password');
    }
    setLoading(false);
  };

  return (
    <Modal title={`Reset Password for ${user.displayName}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="text-xs text-gray-600 bg-gray-50 rounded-lg p-2">
          Set a new password for this user. Share it with them securely.
        </div>
        <Field label="New Password">
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} className="input" autoFocus />
        </Field>
        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={handleSave} disabled={loading} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-lg">
            Reset Password
          </button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}

function ChangePasswordModal({ user, onClose, onSuccess }) {
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    setErr('');
    if (!currentPw) return setErr('Enter current password');
    if (newPw.length < 6) return setErr('New password must be at least 6 characters');
    if (newPw !== confirmPw) return setErr('New passwords do not match');

    setLoading(true);
    try {
      await api.changePassword(user.id, currentPw, newPw);
      onSuccess();
    } catch (e) {
      setErr(e.message || 'Failed to change password');
    }
    setLoading(false);
  };

  return (
    <Modal title="Change Password" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Current Password">
          <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} className="input" autoFocus />
        </Field>
        <Field label="New Password">
          <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} className="input" />
        </Field>
        <Field label="Confirm New Password">
          <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} className="input" />
        </Field>
        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={handleSave} disabled={loading} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-lg">
            {loading ? 'Updating...' : 'Update Password'}
          </button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}

function ItemFormModal({ title, item, sales, existingItems = [], onSave, onClose }) {
  const isEditing = !!item;
  const [form, setForm] = useState({
    sku: item?.sku || '',
    type: item?.type || 'tc',
    name: item?.name || '',
    variety: item?.variety || '',
    quantity: item?.quantity || 1,
    grossCost: item?.grossCost ?? item?.cost ?? '',
    netCost: item?.netCost ?? '',
    profitRate: item?.profitRate ?? '',
    idealPrice: item?.idealPrice ?? '',
    listingPrice: item?.listingPrice || '',
    salePrice: item?.salePrice || '',
    source: item?.source || '',
    acquiredAt: item?.acquiredAt || new Date().toISOString().slice(0, 10),
    notes: item?.notes || '',
    status: item?.status || 'available',
    saleId: item?.saleId || '',
    lotNumber: item?.lotNumber || '',
    imageUrl: item?.imageUrl || '',
  });
  const [err, setErr] = useState('');

  // Auto-generate SKU as the next sequential number across all items (new items only).
  useEffect(() => {
    if (isEditing) return;
    const existingNums = existingItems
      .map(i => {
        const s = String(i.sku || '').trim();
        return /^\d+$/.test(s) ? parseInt(s, 10) : 0;
      })
      .filter(n => n > 0);
    const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1;
    setForm(f => ({ ...f, sku: String(nextNum) }));
  }, [isEditing, existingItems]);

  // Auto-calc ideal price from net cost × (1 + profit rate/100)
  const recalcIdeal = (netCost, profitRate) => {
    const c = parseFloat(netCost);
    const p = parseFloat(profitRate);
    if (!isNaN(c) && !isNaN(p)) {
      return (c * (1 + p / 100)).toFixed(2);
    }
    return form.idealPrice;
  };

  const handleSubmit = () => {
    if (!form.variety) return setErr('Variety is required');
    if (!form.name.trim()) return setErr('Name is required');
    if (!form.sku.trim()) return setErr('SKU could not be generated — try again');
    // Defense-in-depth: ensure we didn't accidentally pick an SKU that's already taken.
    if (!isEditing && existingItems.some(i => String(i.sku || '').trim() === form.sku.trim())) {
      return setErr(`SKU "${form.sku}" already exists. Please retry.`);
    }
    onSave({
      ...form,
      cost: form.grossCost, // backward compat
      saleId: form.saleId || null,
      lotNumber: form.lotNumber || null,
    });
  };

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Type *">
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="input">
              <option value="tc">TC (Tissue Culture)</option>
              <option value="plant">Plant</option>
            </select>
          </Field>
          <Field label="Quantity">
            <input type="number" min="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} className="input" />
          </Field>
        </div>
        <Field label="Variety *">
          <select value={form.variety} onChange={(e) => setForm({ ...form, variety: e.target.value })} className="input">
            <option value="">Select variety…</option>
            {VARIETIES.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </Field>
        <Field label="Plant Name *">
          <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input" placeholder="e.g. Monstera Albo Japanese" />
        </Field>

        <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-xs">
          <span className="text-gray-500">{isEditing ? 'SKU' : 'SKU (auto-assigned)'}</span>
          <span className="font-mono font-bold text-gray-900">{form.sku || '—'}</span>
        </div>

        <div className="border-t border-gray-200 pt-3">
          <div className="text-xs font-semibold text-gray-700 mb-2">Cost & Pricing</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Gross Cost">
              <input
                type="number" step="0.01" value={form.grossCost}
                onChange={(e) => setForm({ ...form, grossCost: e.target.value })}
                className="input" placeholder="0.00"
              />
            </Field>
            <Field label="Net Cost (incl. overhead)">
              <input
                type="number" step="0.01" value={form.netCost}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm({ ...form, netCost: v, idealPrice: recalcIdeal(v, form.profitRate) });
                }}
                className="input" placeholder="0.00"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <Field label="Target Profit Rate (%)">
              <input
                type="number" step="1" value={form.profitRate}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm({ ...form, profitRate: v, idealPrice: recalcIdeal(form.netCost, v) });
                }}
                className="input" placeholder="200"
              />
            </Field>
            <Field label="Ideal Sale Price">
              <input
                type="number" step="0.01" value={form.idealPrice}
                onChange={(e) => setForm({ ...form, idealPrice: e.target.value })}
                className="input bg-emerald-50/50" placeholder="auto"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <Field label="Listing Price">
              <input type="number" step="0.01" value={form.listingPrice} onChange={(e) => setForm({ ...form, listingPrice: e.target.value })} className="input" placeholder="0.00" />
            </Field>
            <Field label="Sold Price">
              <input type="number" step="0.01" value={form.salePrice} onChange={(e) => setForm({ ...form, salePrice: e.target.value })} className="input" placeholder="0.00" />
            </Field>
          </div>
        </div>

        <div className="border-t border-gray-200 pt-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Source / Supplier">
              <input type="text" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} className="input" />
            </Field>
            <Field label="Acquired Date">
              <input type="date" value={form.acquiredAt} onChange={(e) => setForm({ ...form, acquiredAt: e.target.value })} className="input" />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <Field label="Sale Event">
              <select value={form.saleId} onChange={(e) => setForm({ ...form, saleId: e.target.value })} className="input">
                <option value="">None</option>
                {sales.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Lot Number">
              <input type="text" value={form.lotNumber} onChange={(e) => setForm({ ...form, lotNumber: e.target.value })} className="input" />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Status">
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="input">
                <option value="available">Available</option>
                <option value="listed">Listed</option>
                <option value="sold">Sold</option>
                <option value="shipped">Shipped</option>
                <option value="delivered">Delivered</option>
              </select>
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Image URL (for Palmstreet)">
              <input type="url" value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value })} className="input" placeholder="https://..." />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Notes / Description">
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows="2" className="input resize-none" />
            </Field>
          </div>
        </div>

        {item && (item.createdBy || item.modifiedBy) && (
          <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-2 space-y-0.5">
            {item.createdBy && <div>Created by {item.createdBy} on {new Date(item.createdAt).toLocaleDateString()}</div>}
            {item.modifiedBy && <div>Last modified by {item.modifiedBy} on {new Date(item.modifiedAt).toLocaleDateString()}</div>}
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={handleSubmit} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg">Save</button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}

function BatchVarietyModal({ existingItems, onSave, onClose }) {
  const [form, setForm] = useState({
    type: 'tc',
    name: '',
    variety: '',
    quantity: 5,
    skuStart: 1,
    grossCost: '',
    netCost: '',
    profitRate: '200',
    idealPrice: '',
    listingPrice: '',
    source: '',
    acquiredAt: new Date().toISOString().slice(0, 10),
    notes: '',
    imageUrl: '',
  });
  const [err, setErr] = useState('');
  const [startManuallyEdited, setStartManuallyEdited] = useState(false);

  // Auto-compute starting number as max existing numeric SKU + 1.
  useEffect(() => {
    if (startManuallyEdited) return;
    const existingNums = existingItems
      .map(i => {
        const s = String(i.sku || '').trim();
        return /^\d+$/.test(s) ? parseInt(s, 10) : 0;
      })
      .filter(n => n > 0);
    const nextStart = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1;
    setForm(f => ({ ...f, skuStart: nextStart }));
  }, [existingItems, startManuallyEdited]);

  // Auto-calc ideal price
  useEffect(() => {
    const c = parseFloat(form.netCost);
    const p = parseFloat(form.profitRate);
    if (!isNaN(c) && !isNaN(p)) {
      setForm(f => ({ ...f, idealPrice: (c * (1 + p / 100)).toFixed(2) }));
    }
  }, [form.netCost, form.profitRate]);

  const previewSkus = useMemo(() => {
    const qty = parseInt(form.quantity) || 0;
    const start = parseInt(form.skuStart) || 1;
    const result = [];
    for (let i = 0; i < Math.min(qty, 5); i++) {
      result.push(String(start + i));
    }
    return result;
  }, [form.skuStart, form.quantity]);

  const handleSubmit = () => {
    setErr('');
    if (!form.variety) return setErr('Variety is required');
    if (!form.name.trim()) return setErr('Plant name is required');
    const qty = parseInt(form.quantity);
    if (!qty || qty < 1) return setErr('Quantity must be at least 1');
    if (qty > 500) return setErr('Maximum 500 items per batch');

    const start = parseInt(form.skuStart) || 1;
    const existingSkuSet = new Set(existingItems.map(i => String(i.sku || '')));

    const items = [];
    const duplicates = [];
    for (let i = 0; i < qty; i++) {
      const sku = String(start + i);
      if (existingSkuSet.has(sku)) {
        duplicates.push(sku);
        continue;
      }
      existingSkuSet.add(sku);
      items.push({
        sku,
        type: form.type,
        name: form.name.trim(),
        variety: form.variety.trim(),
        quantity: 1,
        grossCost: form.grossCost,
        cost: form.grossCost,
        netCost: form.netCost,
        profitRate: form.profitRate,
        idealPrice: form.idealPrice,
        listingPrice: form.listingPrice || form.idealPrice,
        source: form.source,
        acquiredAt: form.acquiredAt,
        notes: form.notes,
        imageUrl: form.imageUrl,
      });
    }

    if (duplicates.length === qty) {
      setErr(`All ${qty} SKUs conflict with existing items. Try changing the starting number.`);
      return;
    }
    if (duplicates.length > 0) {
      if (!confirm(`${duplicates.length} SKU(s) already exist and will be skipped: ${duplicates.slice(0, 3).join(', ')}${duplicates.length > 3 ? '...' : ''}. Create the other ${items.length}?`)) {
        return;
      }
    }

    onSave(items);
  };

  const totalInvestment = (parseFloat(form.netCost) || 0) * (parseInt(form.quantity) || 0);
  const totalPotential = (parseFloat(form.idealPrice) || 0) * (parseInt(form.quantity) || 0);
  const totalProfit = totalPotential - totalInvestment;

  return (
    <Modal title="Add Variety (Batch)" onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-sky-50 border border-sky-200 rounded-lg p-3 text-xs text-sky-900">
          <div className="font-medium mb-1">Create multiple unique SKUs for one variety</div>
          <div>Fill in the plant details — SKUs will be generated automatically.</div>
        </div>

        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Type *">
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="input">
              <option value="tc">TC (Tissue Culture)</option>
              <option value="plant">Plant</option>
            </select>
          </Field>
          <Field label="Quantity *">
            <input type="number" min="1" max="500" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} className="input" />
          </Field>
        </div>
        <Field label="Variety *">
          <select value={form.variety} onChange={(e) => setForm({ ...form, variety: e.target.value })} className="input">
            <option value="">Select variety…</option>
            {VARIETIES.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </Field>
        <Field label="Plant Name *">
          <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input" placeholder="e.g. Monstera Albo Japanese" />
        </Field>

        {previewSkus.length > 0 && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 space-y-2">
            <div className="text-xs">
              <span className="font-medium text-emerald-900">SKUs: </span>
              <span className="font-mono text-emerald-800">{previewSkus[0]}
                {previewSkus.length > 1 && ` → ${previewSkus[previewSkus.length - 1]}`}
                {parseInt(form.quantity) > 5 && ` … (${form.quantity} total)`}
              </span>
            </div>
            <Field label="Start number">
              <div className="flex gap-2">
                <input
                  type="number"
                  min="1"
                  value={form.skuStart}
                  onChange={(e) => { setForm({ ...form, skuStart: e.target.value }); setStartManuallyEdited(true); }}
                  className="input font-mono flex-1"
                />
                {startManuallyEdited && (
                  <button
                    type="button"
                    onClick={() => setStartManuallyEdited(false)}
                    className="px-2 py-1 text-xs text-gray-600 hover:text-gray-900 border border-gray-300 rounded whitespace-nowrap"
                  >
                    Auto
                  </button>
                )}
              </div>
            </Field>
          </div>
        )}

        <div className="border-t border-gray-200 pt-3">
          <div className="text-xs font-semibold text-gray-700 mb-2">Cost & Pricing (applied to all items)</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Gross Cost">
              <input type="number" step="0.01" value={form.grossCost} onChange={(e) => setForm({ ...form, grossCost: e.target.value })} className="input" placeholder="10.00" />
            </Field>
            <Field label="Net Cost (incl. overhead)">
              <input type="number" step="0.01" value={form.netCost} onChange={(e) => setForm({ ...form, netCost: e.target.value })} className="input" placeholder="15.00" />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <Field label="Target Profit Rate (%)">
              <input type="number" step="1" value={form.profitRate} onChange={(e) => setForm({ ...form, profitRate: e.target.value })} className="input" placeholder="200" />
            </Field>
            <Field label="Ideal Sale Price">
              <input type="number" step="0.01" value={form.idealPrice} onChange={(e) => setForm({ ...form, idealPrice: e.target.value })} className="input bg-emerald-50/50" />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Listing Price (defaults to Ideal)">
              <input type="number" step="0.01" value={form.listingPrice} onChange={(e) => setForm({ ...form, listingPrice: e.target.value })} className="input" placeholder="Leave blank to use Ideal" />
            </Field>
          </div>

          {totalInvestment > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div className="bg-gray-50 rounded-lg p-2">
                <div className="text-gray-500">Total cost</div>
                <div className="font-semibold text-gray-900">${totalInvestment.toFixed(2)}</div>
              </div>
              <div className="bg-emerald-50 rounded-lg p-2">
                <div className="text-emerald-600">Potential revenue</div>
                <div className="font-semibold text-emerald-900">${totalPotential.toFixed(2)}</div>
              </div>
              <div className="bg-violet-50 rounded-lg p-2">
                <div className="text-violet-600">Projected profit</div>
                <div className="font-semibold text-violet-900">${totalProfit.toFixed(2)}</div>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 pt-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Source / Supplier">
              <input type="text" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} className="input" />
            </Field>
            <Field label="Acquired Date">
              <input type="date" value={form.acquiredAt} onChange={(e) => setForm({ ...form, acquiredAt: e.target.value })} className="input" />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Image URL">
              <input type="url" value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value })} className="input" placeholder="https://..." />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Notes / Description">
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows="2" className="input resize-none" />
            </Field>
          </div>
        </div>

        <div className="flex gap-2 justify-end pt-2 sticky bottom-0 bg-white">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={handleSubmit} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> Create {form.quantity || 0} Items
          </button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}

function ConvertModal({ item, existingItems = [], onConvert, onClose }) {
  // Assign the next sequential numeric SKU across all items.
  const nextSku = useMemo(() => {
    const nums = existingItems
      .map(i => {
        const s = String(i.sku || '').trim();
        return /^\d+$/.test(s) ? parseInt(s, 10) : 0;
      })
      .filter(n => n > 0);
    return String(nums.length > 0 ? Math.max(...nums) + 1 : 1);
  }, [existingItems]);

  const [form, setForm] = useState({
    sku: nextSku,
    name: item.name,
    variety: item.variety || '',
    cost: item.cost || '',
    listingPrice: '',
    notes: item.notes || '',
    quantity: item.quantity || 1,
  });

  return (
    <Modal title={`Convert ${item.sku} to Plant`} onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-sky-50 border border-sky-200 rounded-lg p-3 text-xs text-sky-900">
          <div className="font-medium mb-1">Converting tissue culture to plant</div>
          <div>The original TC SKU will be marked as "converted" and a new Plant SKU will be created, preserving the lineage.</div>
        </div>
        <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-xs">
          <span className="text-gray-500">New Plant SKU (auto-assigned)</span>
          <span className="font-mono font-bold text-gray-900">{form.sku}</span>
        </div>
        <Field label="Plant Name *">
          <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input" />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Variety *">
            <select value={form.variety} onChange={(e) => setForm({ ...form, variety: e.target.value })} className="input">
              <option value="">Select variety…</option>
              {VARIETIES.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Quantity">
            <input type="number" min="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} className="input" />
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Adjusted Cost">
            <input type="number" step="0.01" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} className="input" />
          </Field>
          <Field label="New Listing Price">
            <input type="number" step="0.01" value={form.listingPrice} onChange={(e) => setForm({ ...form, listingPrice: e.target.value })} className="input" />
          </Field>
        </div>
        <Field label="Notes">
          <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows="2" className="input resize-none" />
        </Field>
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={() => onConvert(form)} disabled={!form.sku || !form.name} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-lg flex items-center gap-1.5">
            <ArrowRightLeft className="w-4 h-4" /> Convert
          </button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}

function BulkImportModal({ onImport, onClose }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');

  const parseText = () => {
    setErr('');
    try {
      const lines = text.trim().split('\n').filter(l => l.trim());
      if (lines.length < 2) {
        setErr('Need at least a header row and one data row.');
        return;
      }
      const delim = lines[0].includes('\t') ? '\t' : ',';
      const headers = lines[0].split(delim).map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
      const required = ['sku', 'type', 'name'];
      const missing = required.filter(r => !headers.includes(r));
      if (missing.length) {
        setErr(`Missing required columns: ${missing.join(', ')}`);
        return;
      }
      const parsed = lines.slice(1).map(line => {
        const vals = line.split(delim).map(v => v.trim().replace(/^"|"$/g, ''));
        const obj = {};
        headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
        return {
          sku: obj.sku,
          type: obj.type?.toLowerCase() === 'plant' ? 'plant' : 'tc',
          name: obj.name,
          variety: obj.variety || '',
          quantity: parseInt(obj.quantity) || 1,
          cost: obj.cost || '',
          listingPrice: obj['listing price'] || obj.listingprice || obj.price || '',
          source: obj.source || '',
          notes: obj.notes || obj.description || '',
          imageUrl: obj['image url'] || obj.imageurl || obj.image || '',
          status: 'available',
        };
      }).filter(i => i.sku && i.name);
      setPreview(parsed);
    } catch (e) {
      setErr('Could not parse. Check format.');
    }
  };

  return (
    <Modal title="Bulk Import SKUs" onClose={onClose}>
      <div className="space-y-3">
        <div className="text-xs text-gray-600">
          Paste CSV or TSV. Required columns: <span className="font-mono bg-gray-100 px-1">sku</span>, <span className="font-mono bg-gray-100 px-1">type</span>, <span className="font-mono bg-gray-100 px-1">name</span>. Optional: variety, quantity, cost, listing price, image url, source, notes.
        </div>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setPreview(null); }}
          rows="8"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
          placeholder="sku,type,name,variety,quantity,cost,listing price&#10;TC-001,tc,Monstera Albo,Japanese,1,15,45"
        />
        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}
        {preview && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900">
            <div className="font-medium mb-1">Ready to import {preview.length} items</div>
            <div className="text-emerald-700">First row: {preview[0]?.sku} · {preview[0]?.name}</div>
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          {!preview ? (
            <button onClick={parseText} className="px-4 py-2 text-sm bg-gray-900 hover:bg-gray-800 text-white rounded-lg">Preview</button>
          ) : (
            <button onClick={() => onImport(preview)} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-1.5">
              <Check className="w-4 h-4" /> Import {preview.length}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function SaleFormModal({ onSave, onClose }) {
  const [form, setForm] = useState({
    name: '',
    date: new Date().toISOString().slice(0, 10),
    platform: 'Palmstreet',
    notes: '',
  });
  return (
    <Modal title="New Sale Event" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Event Name *">
          <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input" placeholder="Friday TC Sale" />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Date">
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="input" />
          </Field>
          <Field label="Platform">
            <input type="text" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} className="input" />
          </Field>
        </div>
        <Field label="Notes">
          <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows="2" className="input resize-none" />
        </Field>
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={() => form.name && onSave(form)} disabled={!form.name} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-lg">Create</button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}

function AssignSaleModal({ item, sales, items, onAssign, onClose }) {
  const [saleId, setSaleId] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [err, setErr] = useState('');

  const submit = () => {
    if (!saleId) return setErr('Pick a sale event');
    if (lotNumber) {
      const dup = items.find(i => i.id !== item.id && i.saleId === saleId && i.lotNumber === lotNumber);
      if (dup) return setErr(`Lot #${lotNumber} is already used by ${dup.sku}`);
    }
    onAssign(saleId, lotNumber || null);
  };

  return (
    <Modal title={`Assign ${item.sku} to Sale`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Sale Event">
          {sales.length === 0 ? (
            <div className="text-xs text-gray-500 p-3 bg-gray-50 rounded-lg">No sale events yet. Create one first.</div>
          ) : (
            <select value={saleId} onChange={(e) => setSaleId(e.target.value)} className="input">
              <option value="">-- Pick sale --</option>
              {sales.map(s => <option key={s.id} value={s.id}>{s.name} ({s.date})</option>)}
            </select>
          )}
        </Field>
        <Field label="Lot Number (optional)">
          <input type="text" value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} className="input" placeholder="e.g. 12" />
        </Field>
        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={submit} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg">Assign</button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="p-1 text-gray-500 hover:bg-gray-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-700 block mb-1">{label}</span>
      {children}
    </label>
  );
}

function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white rounded-xl w-full max-w-sm overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="p-5">
          <div className="flex items-start gap-3">
            {danger && (
              <div className="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                <AlertCircle className="w-5 h-5 text-red-600" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-gray-900">{title}</h3>
              <p className="text-sm text-gray-600 mt-1">{message}</p>
            </div>
          </div>
        </div>
        <div className="bg-gray-50 px-5 py-3 flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm text-white rounded-lg ${
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            {confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

function LineupBuilder({ sale, items, onSave, onClose }) {
  const eligible = useMemo(() => {
    return items.filter(i => {
      if (i.saleId === sale.id) return true;
      if (i.saleId && i.saleId !== sale.id) return false;
      return ['available', 'listed'].includes(i.status);
    });
  }, [items, sale.id]);

  const initialSelected = useMemo(() => {
    const m = {};
    items.filter(i => i.saleId === sale.id).forEach(i => {
      m[i.id] = { lotNumber: i.lotNumber || '' };
    });
    return m;
  }, [items, sale.id]);

  const [selected, setSelected] = useState(initialSelected);
  const [groupBy, setGroupBy] = useState('price');
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState({});

  const toggleItem = (id) => {
    setSelected(prev => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = { lotNumber: '' };
      return next;
    });
  };

  const toggleGroup = (ids, allSelected) => {
    setSelected(prev => {
      const next = { ...prev };
      if (allSelected) {
        ids.forEach(id => delete next[id]);
      } else {
        ids.forEach(id => { if (!next[id]) next[id] = { lotNumber: '' }; });
      }
      return next;
    });
  };

  const setLot = (id, lot) => {
    setSelected(prev => ({ ...prev, [id]: { ...prev[id], lotNumber: lot } }));
  };

  const autoNumber = () => {
    const sortedIds = Object.keys(selected).sort((a, b) => {
      const ia = eligible.find(i => i.id === a);
      const ib = eligible.find(i => i.id === b);
      const pa = parseFloat(ia?.listingPrice) || 0;
      const pb = parseFloat(ib?.listingPrice) || 0;
      return pa - pb;
    });
    const next = { ...selected };
    sortedIds.forEach((id, idx) => {
      next[id] = { ...next[id], lotNumber: String(idx + 1) };
    });
    setSelected(next);
  };

  const clearLots = () => {
    const next = {};
    Object.keys(selected).forEach(id => { next[id] = { lotNumber: '' }; });
    setSelected(next);
  };

  const handleSave = () => {
    const lotCounts = {};
    Object.values(selected).forEach(s => {
      if (s.lotNumber) {
        lotCounts[s.lotNumber] = (lotCounts[s.lotNumber] || 0) + 1;
      }
    });
    const dupes = Object.entries(lotCounts).filter(([, c]) => c > 1).map(([n]) => n);
    if (dupes.length) {
      alert(`Duplicate lot numbers: ${dupes.join(', ')}`);
      return;
    }

    const updates = [];
    Object.entries(selected).forEach(([id, meta]) => {
      updates.push({ id, saleId: sale.id, lotNumber: meta.lotNumber || null });
    });
    items.filter(i => i.saleId === sale.id && !selected[i.id]).forEach(i => {
      updates.push({ id: i.id, saleId: null, lotNumber: null });
    });
    onSave(updates);
  };

  const filtered = useMemo(() => {
    return eligible.filter(i => {
      if (typeFilter !== 'all' && i.type !== typeFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          i.sku?.toLowerCase().includes(q) ||
          i.name?.toLowerCase().includes(q) ||
          i.variety?.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [eligible, typeFilter, search]);

  const grouped = useMemo(() => {
    const groups = {};
    const order = [];

    if (groupBy === 'price') {
      PRICE_BUCKETS.forEach(b => { groups[b.label] = []; order.push(b.label); });
      filtered.forEach(item => {
        const price = parseFloat(item.listingPrice);
        if (!price || isNaN(price)) {
          groups['No price set'].push(item);
          return;
        }
        const bucket = PRICE_BUCKETS.find(b => b.min !== null && price >= b.min && price < b.max);
        if (bucket) groups[bucket.label].push(item);
      });
    } else if (groupBy === 'variety') {
      filtered.forEach(item => {
        const key = item.variety?.trim() || item.name?.trim() || 'Unlabeled';
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(item);
      });
      order.sort();
    } else if (groupBy === 'type') {
      groups['TC'] = [];
      groups['Plant'] = [];
      order.push('TC', 'Plant');
      filtered.forEach(item => {
        if (item.type === 'tc') groups['TC'].push(item);
        else groups['Plant'].push(item);
      });
    }

    return { groups, order: order.filter(k => groups[k]?.length > 0) };
  }, [filtered, groupBy]);

  const selectedCount = Object.keys(selected).length;
  const selectedValue = Object.keys(selected).reduce((sum, id) => {
    const item = eligible.find(i => i.id === id);
    return sum + (parseFloat(item?.listingPrice) || 0);
  }, 0);

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-stretch sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-5xl h-full sm:h-[90vh] sm:rounded-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 py-3 flex items-center justify-between flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2">
              <Layers className="w-4 h-4 text-emerald-600" />
              Build Lineup · <span className="truncate">{sale.name}</span>
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">{sale.date} · {sale.platform || 'Palmstreet'}</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:bg-gray-100 rounded ml-2">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="border-b border-gray-200 px-4 py-3 space-y-2 flex-shrink-0 bg-gray-50">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1 relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search SKU, name, variety..."
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
              />
            </div>
            <div className="flex gap-2">
              <div className="flex items-center bg-white border border-gray-300 rounded-lg p-0.5">
                {[
                  { v: 'price', label: 'Price', icon: DollarSign },
                  { v: 'variety', label: 'Variety', icon: Tag },
                  { v: 'type', label: 'Type', icon: Sprout },
                ].map(opt => {
                  const Ic = opt.icon;
                  return (
                    <button
                      key={opt.v}
                      onClick={() => setGroupBy(opt.v)}
                      className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded transition ${
                        groupBy === opt.v ? 'bg-emerald-600 text-white' : 'text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      <Ic className="w-3 h-3" /> {opt.label}
                    </button>
                  );
                })}
              </div>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="text-sm px-2 py-1.5 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="all">All types</option>
                <option value="tc">TC only</option>
                <option value="plant">Plant only</option>
              </select>
            </div>
          </div>
          {selectedCount > 0 && (
            <div className="flex items-center gap-2 pt-1">
              <button onClick={autoNumber} className="flex items-center gap-1 px-2 py-1 text-xs bg-white border border-gray-300 rounded-lg hover:bg-gray-100">
                <ListOrdered className="w-3 h-3" /> Auto-number by price
              </button>
              <button onClick={clearLots} className="text-xs text-gray-600 hover:text-gray-900 px-2 py-1">
                Clear lot numbers
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {grouped.order.length === 0 ? (
            <div className="text-center py-12 text-sm text-gray-500">
              No items match. Try changing filters or add more inventory.
            </div>
          ) : (
            <div className="space-y-4">
              {grouped.order.map(groupKey => {
                const groupItems = grouped.groups[groupKey];
                const ids = groupItems.map(i => i.id);
                const allSelected = ids.every(id => selected[id]);
                const someSelected = ids.some(id => selected[id]);
                const isCollapsed = collapsed[groupKey];
                const groupValue = groupItems.reduce((s, i) => s + (parseFloat(i.listingPrice) || 0), 0);

                return (
                  <div key={groupKey} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                    <div className="bg-gray-50 px-3 py-2 flex items-center justify-between border-b border-gray-200">
                      <button
                        onClick={() => setCollapsed(prev => ({ ...prev, [groupKey]: !prev[groupKey] }))}
                        className="flex items-center gap-2 text-left flex-1 min-w-0"
                      >
                        <span className={`text-xs transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▶</span>
                        <span className="font-medium text-sm text-gray-900 truncate">{groupKey}</span>
                        <span className="text-xs text-gray-500 whitespace-nowrap">
                          {groupItems.length} items · ${groupValue.toFixed(0)}
                        </span>
                      </button>
                      <label className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer ml-2 whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
                          onChange={() => toggleGroup(ids, allSelected)}
                          className="w-3.5 h-3.5 rounded text-emerald-600 focus:ring-emerald-500"
                        />
                        Select all
                      </label>
                    </div>
                    {!isCollapsed && (
                      <div className="divide-y divide-gray-100">
                        {groupItems.map(item => {
                          const isSelected = !!selected[item.id];
                          const lotValue = selected[item.id]?.lotNumber || '';
                          return (
                            <label
                              key={item.id}
                              className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 transition ${
                                isSelected ? 'bg-emerald-50/50' : ''
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleItem(item.id)}
                                className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 flex-shrink-0"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                                    item.type === 'tc' ? 'bg-sky-500' : 'bg-emerald-500'
                                  }`} />
                                  <span className="font-medium text-sm text-gray-900 truncate">{item.name}</span>
                                  {item.variety && (
                                    <span className="text-xs text-gray-500 truncate">· {item.variety}</span>
                                  )}
                                </div>
                                <div className="text-xs text-gray-500 font-mono">{item.sku}</div>
                              </div>
                              <div className="text-sm font-medium text-gray-900 w-16 text-right flex-shrink-0">
                                {item.listingPrice ? `$${parseFloat(item.listingPrice).toFixed(0)}` : '—'}
                              </div>
                              {isSelected && (
                                <input
                                  type="text"
                                  value={lotValue}
                                  onChange={(e) => setLot(item.id, e.target.value)}
                                  onClick={(e) => e.preventDefault()}
                                  placeholder="Lot #"
                                  className="w-16 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-emerald-500 flex-shrink-0"
                                />
                              )}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 px-4 py-3 flex items-center justify-between flex-shrink-0 bg-white">
          <div className="text-sm">
            <span className="font-semibold text-gray-900">{selectedCount}</span>
            <span className="text-gray-500"> lots selected · </span>
            <span className="font-semibold text-emerald-700">${selectedValue.toFixed(0)}</span>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
            <button onClick={handleSave} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-1.5">
              <Check className="w-4 h-4" /> Save Lineup
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReconcileModal({ sale, items, onApply, onClose }) {
  const [fileName, setFileName] = useState('');
  const [parsedRows, setParsedRows] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [markUnsoldAs, setMarkUnsoldAs] = useState('unassign');

  const lineupItems = useMemo(() => items.filter(i => i.saleId === sale.id), [items, sale.id]);

  const matches = useMemo(() => {
    if (!parsedRows) return null;
    const skuMap = new Map();
    lineupItems.forEach(i => {
      if (i.sku) skuMap.set(String(i.sku).trim().toLowerCase(), i);
    });

    const matched = [];
    const unmatched = [];
    const matchedIds = new Set();

    parsedRows.forEach(row => {
      const key = String(row.sku || '').trim().toLowerCase();
      if (key && skuMap.has(key)) {
        const item = skuMap.get(key);
        matched.push({ row, item });
        matchedIds.add(item.id);
      } else {
        unmatched.push(row);
      }
    });

    const unsold = lineupItems.filter(i => !matchedIds.has(i.id));
    return { matched, unmatched, unsold };
  }, [parsedRows, lineupItems]);

  const handleFile = async (file) => {
    setErr('');
    setLoading(true);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      if (!rows.length) {
        setErr('No rows found in the spreadsheet.');
        setLoading(false);
        return;
      }

      const firstRow = rows[0];
      const keys = Object.keys(firstRow);
      const findKey = (patterns) => {
        for (const p of patterns) {
          const found = keys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '').includes(p));
          if (found) return found;
        }
        return null;
      };

      const skuKey = findKey(['sku']);
      const priceKey = findKey(['soldprice', 'saleprice', 'price', 'amount', 'total']);
      const qtyKey = findKey(['quantity', 'qty']);
      const titleKey = findKey(['title', 'productname', 'itemname', 'product']);
      const buyerKey = findKey(['buyer', 'customer', 'username']);
      const orderKey = findKey(['orderid', 'ordernumber', 'order']);

      if (!skuKey) {
        setErr(`Couldn't find a SKU column. Available columns: ${keys.join(', ')}`);
        setLoading(false);
        return;
      }

      const parsed = rows.map(r => ({
        sku: String(r[skuKey] || '').trim(),
        price: priceKey ? parseFloat(r[priceKey]) || 0 : 0,
        quantity: qtyKey ? parseInt(r[qtyKey]) || 1 : 1,
        title: titleKey ? String(r[titleKey] || '') : '',
        buyer: buyerKey ? String(r[buyerKey] || '') : '',
        orderId: orderKey ? String(r[orderKey] || '') : '',
        raw: r,
      })).filter(r => r.sku);

      setParsedRows(parsed);
    } catch (e) {
      setErr(`Could not read file: ${e.message}`);
    }
    setLoading(false);
  };

  const handleApply = () => {
    if (!matches) return;
    const updates = [];

    matches.matched.forEach(({ row, item }) => {
      const finalSalePrice = row.price > 0 ? row.price : parseFloat(item.listingPrice) || 0;
      const cost = parseFloat(item.grossCost ?? item.cost) || 0;
      const profit = cost > 0 ? finalSalePrice - cost : null;
      const profitRate = cost > 0 ? ((finalSalePrice - cost) / cost) * 100 : null;
      updates.push({
        id: item.id,
        status: 'sold',
        salePrice: finalSalePrice,
        soldAt: new Date().toISOString(),
        buyer: row.buyer || item.buyer,
        orderId: row.orderId || null,
        // Snapshot profit at time of reconciliation (also computed on the fly elsewhere)
        actualProfit: profit,
        actualProfitRate: profitRate,
      });
    });

    matches.unsold.forEach(item => {
      const update = { id: item.id };
      if (markUnsoldAs === 'unassign') {
        update.saleId = null;
        update.lotNumber = null;
        update.status = 'available';
      } else if (markUnsoldAs === 'available') {
        update.status = 'available';
      } else {
        return;
      }
      updates.push(update);
    });

    onApply(updates);
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-stretch sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-3xl h-full sm:h-auto sm:max-h-[90vh] sm:rounded-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 py-3 flex items-center justify-between flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2">
              <FileCheck className="w-4 h-4 text-amber-600" />
              Reconcile Orders · <span className="truncate">{sale.name}</span>
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">Import Palmstreet orders to mark sold items and return unsold to inventory</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:bg-gray-100 rounded ml-2">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!parsedRows && (
            <div>
              <label className="block">
                <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-emerald-400 hover:bg-emerald-50/50 cursor-pointer transition">
                  <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                  <div className="text-sm font-medium text-gray-900">
                    {loading ? 'Reading file...' : 'Upload Palmstreet orders file'}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">.xlsx or .csv</div>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }}
                    className="hidden"
                  />
                </div>
              </label>
              {err && (
                <div className="mt-3 flex items-start gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {err}
                </div>
              )}
              <div className="mt-4 text-xs text-gray-600 bg-gray-50 rounded-lg p-3">
                <div className="font-medium text-gray-900 mb-1">What happens next:</div>
                <ul className="space-y-0.5 list-disc list-inside">
                  <li>SKUs in the orders file that match your sale lineup → marked sold with sale price</li>
                  <li>Lineup items NOT in the orders → returned to available inventory</li>
                  <li>You'll see a preview before anything is saved</li>
                </ul>
              </div>
            </div>
          )}

          {parsedRows && matches && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <span className="text-gray-500">File:</span>{' '}
                  <span className="font-medium text-gray-900">{fileName}</span>
                  <span className="text-gray-500"> · {parsedRows.length} order rows</span>
                </div>
                <button onClick={() => { setParsedRows(null); setFileName(''); }} className="text-xs text-gray-600 hover:text-gray-900">
                  Choose different file
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                  <div className="text-xs text-emerald-700">Will mark sold</div>
                  <div className="text-2xl font-semibold text-emerald-900">{matches.matched.length}</div>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <div className="text-xs text-amber-700">Returning to inventory</div>
                  <div className="text-2xl font-semibold text-amber-900">{matches.unsold.length}</div>
                </div>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                  <div className="text-xs text-gray-600">Unmatched orders</div>
                  <div className="text-2xl font-semibold text-gray-900">{matches.unmatched.length}</div>
                </div>
              </div>

              {matches.unsold.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-lg p-3">
                  <div className="text-sm font-medium text-gray-900 mb-2">
                    For the {matches.unsold.length} unsold {matches.unsold.length === 1 ? 'item' : 'items'}:
                  </div>
                  <div className="space-y-1.5">
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input type="radio" name="unsold" checked={markUnsoldAs === 'unassign'} onChange={() => setMarkUnsoldAs('unassign')} className="mt-1" />
                      <div>
                        <div className="text-gray-900">Return to available inventory</div>
                        <div className="text-xs text-gray-500">Unassign from this sale, clear lot number, status = available</div>
                      </div>
                    </label>
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input type="radio" name="unsold" checked={markUnsoldAs === 'available'} onChange={() => setMarkUnsoldAs('available')} className="mt-1" />
                      <div>
                        <div className="text-gray-900">Mark available but keep sale assignment</div>
                        <div className="text-xs text-gray-500">Useful if you want to re-run the same sale</div>
                      </div>
                    </label>
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input type="radio" name="unsold" checked={markUnsoldAs === 'keep'} onChange={() => setMarkUnsoldAs('keep')} className="mt-1" />
                      <div>
                        <div className="text-gray-900">Don't change unsold items</div>
                        <div className="text-xs text-gray-500">Only mark the sold ones</div>
                      </div>
                    </label>
                  </div>
                </div>
              )}

              {matches.matched.length > 0 && (
                <details className="bg-white border border-gray-200 rounded-lg" open>
                  <summary className="px-3 py-2 cursor-pointer text-sm font-medium text-gray-900 bg-emerald-50 border-b border-emerald-200 rounded-t-lg flex items-center justify-between">
                    <span>Matched Sales ({matches.matched.length})</span>
                    {(() => {
                      const withCost = matches.matched.filter(({ row, item }) => {
                        const sp = row.price || parseFloat(item.listingPrice) || 0;
                        const cost = parseFloat(item.grossCost ?? item.cost) || 0;
                        return sp > 0 && cost > 0;
                      });
                      if (withCost.length === 0) return null;
                      const rates = withCost.map(({ row, item }) => {
                        const sp = row.price || parseFloat(item.listingPrice) || 0;
                        const cost = parseFloat(item.grossCost ?? item.cost);
                        return ((sp - cost) / cost) * 100;
                      });
                      const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
                      return (
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                          avgRate >= 200 ? 'bg-emerald-200 text-emerald-900' :
                          avgRate >= 100 ? 'bg-blue-200 text-blue-900' :
                          avgRate >= 0 ? 'bg-amber-200 text-amber-900' :
                          'bg-red-200 text-red-900'
                        }`}>
                          Avg {avgRate >= 0 ? '+' : ''}{avgRate.toFixed(0)}%
                        </span>
                      );
                    })()}
                  </summary>
                  <div className="divide-y divide-gray-100 max-h-60 overflow-y-auto">
                    {matches.matched.map(({ row, item }, idx) => {
                      const sp = row.price || parseFloat(item.listingPrice) || 0;
                      const cost = parseFloat(item.grossCost ?? item.cost) || 0;
                      const hasProfit = sp > 0 && cost > 0;
                      const rate = hasProfit ? ((sp - cost) / cost) * 100 : null;
                      return (
                        <div key={idx} className="flex items-center justify-between px-3 py-2 text-xs">
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-gray-900 truncate">{item.name}{item.variety ? ` · ${item.variety}` : ''}</div>
                            <div className="text-gray-500 font-mono">{item.sku}{row.buyer && ` · ${row.buyer}`}</div>
                          </div>
                          <div className="text-right ml-2 whitespace-nowrap">
                            <div className="text-emerald-700 font-medium">${sp.toFixed(2)}</div>
                            {hasProfit ? (
                              <div className={`text-xs font-medium ${
                                rate >= 100 ? 'text-emerald-600' : rate >= 0 ? 'text-amber-600' : 'text-red-600'
                              }`}>
                                {rate >= 0 ? '+' : ''}{rate.toFixed(0)}%
                              </div>
                            ) : cost === 0 ? (
                              <div className="text-xs text-gray-400">no cost</div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </details>
              )}

              {matches.unsold.length > 0 && (
                <details className="bg-white border border-gray-200 rounded-lg">
                  <summary className="px-3 py-2 cursor-pointer text-sm font-medium text-gray-900 bg-amber-50 border-b border-amber-200 rounded-t-lg">
                    Unsold — Returning to Inventory ({matches.unsold.length})
                  </summary>
                  <div className="divide-y divide-gray-100 max-h-60 overflow-y-auto">
                    {matches.unsold.map(item => (
                      <div key={item.id} className="flex items-center justify-between px-3 py-2 text-xs">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-gray-900 truncate">{item.name}</div>
                          <div className="text-gray-500 font-mono">
                            {item.sku}{item.lotNumber && ` · Lot #${item.lotNumber}`}
                          </div>
                        </div>
                        <div className="text-gray-500 ml-2 whitespace-nowrap">
                          ${parseFloat(item.listingPrice || 0).toFixed(0)}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {matches.unmatched.length > 0 && (
                <details className="bg-white border border-gray-200 rounded-lg">
                  <summary className="px-3 py-2 cursor-pointer text-sm font-medium text-gray-900 bg-gray-50 border-b border-gray-200 rounded-t-lg">
                    Unmatched Orders ({matches.unmatched.length}) — will be ignored
                  </summary>
                  <div className="px-3 py-2 text-xs text-gray-600 bg-gray-50/50">
                    These order rows didn't match any SKU in this sale's lineup. Double-check the SKU column if this looks wrong.
                  </div>
                  <div className="divide-y divide-gray-100 max-h-40 overflow-y-auto">
                    {matches.unmatched.map((row, idx) => (
                      <div key={idx} className="flex items-center justify-between px-3 py-2 text-xs">
                        <div className="min-w-0 flex-1">
                          <div className="text-gray-900 truncate">{row.title || '(no title)'}</div>
                          <div className="text-gray-500 font-mono">{row.sku || '(no SKU)'}</div>
                        </div>
                        <div className="text-gray-500 ml-2 whitespace-nowrap">${row.price.toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>

        {parsedRows && (
          <div className="border-t border-gray-200 px-4 py-3 flex items-center justify-end gap-2 flex-shrink-0 bg-white">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
            <button onClick={handleApply} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-1.5">
              <Check className="w-4 h-4" /> Apply Reconciliation
            </button>
          </div>
        )}
      </div>
    </div>
  );
}