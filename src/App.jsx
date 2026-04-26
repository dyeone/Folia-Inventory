import { useState, useEffect, useMemo, useContext } from 'react';
import {
  Plus, Upload, Trash2, TrendingUp, Archive, Calendar,
  Layers, Users, LogOut, Shield, User, Key, Check, Printer, Package, LineChart,
} from 'lucide-react';
import { api, setAuthUserId } from './api.js';
import { AuthContext } from './AuthContext.js';

import { AuthScreen } from './auth/AuthScreen.jsx';
import { ChangePasswordModal } from './auth/ChangePasswordModal.jsx';
import { Dashboard } from './dashboard/Dashboard.jsx';
import { InventoryView } from './inventory/InventoryView.jsx';
import { ItemFormModal } from './inventory/ItemFormModal.jsx';
import { BatchVarietyModal } from './inventory/BatchVarietyModal.jsx';
import { ConvertModal } from './inventory/ConvertModal.jsx';
import { BulkImportModal } from './inventory/BulkImportModal.jsx';
import { AssignSaleModal } from './inventory/AssignSaleModal.jsx';
import { SalesView } from './sales/SalesView.jsx';
import { SaleFormModal } from './sales/SaleFormModal.jsx';
import { LineupBuilder } from './sales/LineupBuilder.jsx';
import { SalesUploadModal } from './sales/SalesUploadModal.jsx';
import { exportPalmstreetCsv } from './sales/palmstreetExport.js';
import { UsersView } from './users/UsersView.jsx';
import { LabelSheet } from './labels/LabelSheet.jsx';
import { ConfirmDialog } from './ui/ConfirmDialog.jsx';
import { PackingView } from './packing/PackingView.jsx';
import { FinancialView } from './financial/FinancialView.jsx';
import { CatalogModal } from './inventory/CatalogModal.jsx';
import { RecentlyDeletedView } from './inventory/RecentlyDeletedView.jsx';

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
          if (user) {
            setCurrentUser(user);
            setAuthUserId(user.id);
          }
        }
      } catch (e) {
        localStorage.removeItem('session-current-user');
      }
      setLoadingSession(false);
    })();
  }, []);

  const login = (user) => {
    setCurrentUser(user);
    setAuthUserId(user.id);
    localStorage.setItem('session-current-user', JSON.stringify({ id: user.id }));
  };

  const logout = () => {
    setCurrentUser(null);
    setAuthUserId(null);
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

function InventorySystem() {
  const { currentUser, logout } = useContext(AuthContext);
  const isAdmin = currentUser.role === 'admin';

  const [activeTab, setActiveTab] = useState('dashboard');
  const [items, setItems] = useState([]);
  const [deletedItems, setDeletedItems] = useState([]);
  const [sales, setSales] = useState([]);
  const [varieties, setVarieties] = useState([]);
  const [species, setSpecies] = useState([]);
  const [showCatalogModal, setShowCatalogModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [showConvertModal, setShowConvertModal] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showSaleModal, setShowSaleModal] = useState(false);
  const [editingSale, setEditingSale] = useState(null);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showLineupBuilder, setShowLineupBuilder] = useState(false);
  const [lineupSale, setLineupSale] = useState(null);
  const [uploadSale, setUploadSale] = useState(null);
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
  const [labelItems, setLabelItems] = useState(null);
  // { items: [...], title: 'Added N items' } — summary dialog after creation
  const [addSummary, setAddSummary] = useState(null);

  // Split an /items response into active (visible) and trash (soft-deleted)
  // and update both states. Centralizes ordering + the deletedAt partition.
  const applyItemsFresh = (fresh) => {
    const sorted = [...fresh].sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );
    setItems(sorted.filter(i => !i.deletedAt));
    setDeletedItems(sorted.filter(i => i.deletedAt));
  };

  useEffect(() => {
    (async () => {
      try {
        const [itemsData, salesData, varietiesData, speciesData] = await Promise.all([
          api.getItems(),
          api.getSales(),
          api.getVarieties(),
          api.getSpecies(),
        ]);
        const sortByCreated = (arr) =>
          [...arr].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        applyItemsFresh(itemsData);
        setSales(sortByCreated(salesData));
        setVarieties(varietiesData);
        setSpecies(speciesData);
      } catch (e) {
        showToast(e.message || 'Failed to load data', 'error');
      }
      setLoading(false);
    })();
  }, []);

  // Catalog mutations: create immediately to API, optimistic-add to local
  // state so the new item is selectable in the same modal session.
  const addVariety = async ({ name, code }) => {
    const v = await api.createVariety({ name, code });
    setVarieties(prev => [...prev, v].sort((a, b) => a.name.localeCompare(b.name)));
    return v;
  };
  const addSpecies = async ({ varietyId, epithet, commonName, notes, imageUrl }) => {
    const s = await api.createSpecies({ varietyId, epithet, commonName, notes, imageUrl });
    setSpecies(prev => [...prev, s].sort((a, b) => a.epithet.localeCompare(b.epithet)));
    return s;
  };

  // Diff two arrays and return only the rows that were added or changed.
  // Shallow JSON compare is fine here — item/sale objects have stable shapes.
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
      // After a soft-delete, refresh so the trashed rows show up in the
      // Recently Deleted tab right away.
      if (deletedIds.length) {
        const fresh = await api.getItems();
        applyItemsFresh(fresh);
      }
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

  // Server assigns id, createdAt, createdBy, and (if missing) sku.
  // We send the raw item data and let POST /api/items handle the rest,
  // then refresh from the API so the client sees the server-authoritative copy.
  const addItem = async (item) => {
    try {
      // Strip any client-set server-owned fields; let server own them.
      const { id, createdAt, createdBy, modifiedAt, modifiedBy, sku, ...clean } = item;
      await api.upsertItems([{ ...clean, status: item.status || 'available' }]);
      const fresh = await api.getItems();
      applyItemsFresh(fresh);
      // Find the new item in the fresh list to show its generated SKU.
      const newest = fresh.reduce((latest, i) =>
        (!latest || new Date(i.createdAt) > new Date(latest.createdAt)) ? i : latest, null);
      if (newest) {
        setAddSummary({
          title: 'Item added',
          detail: `${newest.sku} · ${newest.name}${newest.variety ? ` · ${newest.variety}` : ''}`,
          items: [newest],
        });
      }
    } catch (e) {
      showToast(e.message || 'Failed to add item', 'error');
    }
  };

  const updateItem = (id, updates) => {
    // Only send id + updates; server stamps modifiedAt/modifiedBy.
    saveItems(items.map(i => i.id === id ? { ...i, ...updates } : i));
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

  const convertToPlant = async (id, conversionData) => {
    const tc = items.find(i => i.id === id);
    if (!tc) return;
    try {
      // Strip client-generated and server-owned fields from plantData.
      const { id: _id, createdAt, createdBy, modifiedAt, modifiedBy, sku, ...plantData } = conversionData;
      const { plant, tc: updatedTc } = await api.convertItem({ tcId: id, plantData });
      setItems([plant, ...items.map(i => i.id === id ? updatedTc : i)]);
      showToast(`Converted ${tc.sku} → ${plant.sku}`);
    } catch (e) {
      showToast(e.message || 'Conversion failed', 'error');
    }
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

    const soldWithCost = allSold.filter(i => {
      const sp = parseFloat(i.salePrice);
      const cost = parseFloat(i.grossCost ?? i.cost);
      return !isNaN(sp) && sp > 0 && !isNaN(cost) && cost > 0;
    });
    let avgProfitRate = null;
    let totalProfit = 0;
    let totalRevenueAllTime = 0;
    if (soldWithCost.length > 0) {
      const rates = soldWithCost.map(i => {
        const sp = parseFloat(i.salePrice);
        const cost = parseFloat(i.grossCost ?? i.cost);
        totalProfit += (sp - cost);
        totalRevenueAllTime += sp;
        return ((sp - cost) / cost) * 100;
      });
      avgProfitRate = rates.reduce((a, b) => a + b, 0) / rates.length;
    }

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
    { id: 'packing', label: 'Packing', icon: Package },
    { id: 'financial', label: 'Financial', icon: LineChart },
    {
      id: 'trash', label: 'Recently Deleted', icon: Trash2,
      badge: deletedItems.length > 0 ? deletedItems.length : null,
    },
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
            <button onClick={() => setShowBulkModal(true)} className="hidden sm:flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg transition">
              <Upload className="w-4 h-4" /> Import
            </button>
            <button onClick={() => setShowAddModal(true)} className="hidden md:flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg transition">
              <Plus className="w-4 h-4" /> Single
            </button>
            <button onClick={() => setShowBatchModal(true)} className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-sm font-medium rounded-lg transition">
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
                      onClick={() => { setShowCatalogModal(true); setShowUserMenu(false); }}
                      className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                    >
                      <Layers className="w-4 h-4" /> Manage Catalog
                    </button>
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
                className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition whitespace-nowrap active:bg-gray-100 ${
                  activeTab === tab.id
                    ? 'border-emerald-600 text-emerald-700'
                    : 'border-transparent text-gray-600 hover:text-gray-900'
                }`}
              >
                <Icon className="w-4 h-4" /> {tab.label}
                {tab.badge != null && (
                  <span className="ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </header>

      {/* Mobile bottom navigation */}
      <nav className="sm:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-gray-200 flex">
        {tabs.map(tab => {
          const Icon = tab.icon;
          const shortLabel = tab.id === 'sales' ? 'Sales'
            : tab.id === 'trash' ? 'Trash'
            : tab.label;
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
            varieties={varieties}
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
            onBulkPrintLabel={(selected) => setLabelItems(selected)}
            onBulkDelete={(ids, clear) => {
              if (!isAdmin) {
                showToast('Only admins can delete items', 'error');
                return;
              }
              setConfirmDialog({
                title: `Delete ${ids.length} ${ids.length === 1 ? 'item' : 'items'}?`,
                message: `Permanently delete ${ids.length} ${ids.length === 1 ? 'item' : 'items'}? This can't be undone.`,
                confirmLabel: 'Delete',
                danger: true,
                onConfirm: async () => {
                  const idSet = new Set(ids);
                  await saveItems(items.filter(i => !idSet.has(i.id)));
                  showToast(`Deleted ${ids.length} ${ids.length === 1 ? 'item' : 'items'}`);
                  clear?.();
                },
              });
            }}
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
            onEdit={(sale) => setEditingSale(sale)}
            onBuildLineup={(sale) => { setLineupSale(sale); setShowLineupBuilder(true); }}
            onExportCsv={async (sale) => {
              const result = exportPalmstreetCsv(sale, items);
              if (!result.ok) { showToast(result.reason, 'error'); return; }
              try {
                await api.upsertSales([{ id: sale.id, exportedAt: new Date().toISOString() }]);
                const fresh = await api.getSales();
                setSales([...fresh].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)));
                showToast(`Exported ${result.count} lots`);
              } catch (e) {
                showToast(e.message || 'Failed to record export', 'error');
              }
            }}
            onUploadSalesReport={(sale) => setUploadSale(sale)}
            onSendToPacking={async (sale) => {
              try {
                await api.upsertSales([{ id: sale.id, status: 'packing' }]);
                const fresh = await api.getSales();
                setSales([...fresh].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)));
                showToast(`${sale.name} sent to Packing`);
                setActiveTab('packing');
              } catch (e) {
                showToast(e.message || 'Failed to send to packing', 'error');
              }
            }}
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
        {activeTab === 'packing' && (
          <PackingView
            inventoryItems={items}
            sales={sales}
            onShipBox={async (saleId, itemIds) => {
              try {
                const now = new Date().toISOString();
                const shipUpdates = itemIds.map(id => ({ id, status: 'shipped', shippedAt: now }));
                await api.upsertItems(shipUpdates);
                const freshItems = await api.getItems();
                applyItemsFresh(freshItems);

                // If every sale lot for this event is now shipped, close the sale.
                const sorted = freshItems.filter(i => !i.deletedAt);
                const saleLots = sorted.filter(i => i.saleId === saleId && i.lotKind !== 'giveaway');
                const allShipped = saleLots.length > 0 && saleLots.every(i => ['shipped', 'delivered'].includes(i.status));
                if (allShipped) {
                  await api.upsertSales([{ id: saleId, status: 'closed', closedAt: now }]);
                  const freshSales = await api.getSales();
                  setSales([...freshSales].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)));
                  showToast('All boxes shipped — sale closed');
                } else {
                  showToast(`Marked ${itemIds.length} ${itemIds.length === 1 ? 'item' : 'items'} shipped`);
                }
              } catch (e) {
                showToast(e.message || 'Ship failed', 'error');
              }
            }}
          />
        )}
        {activeTab === 'financial' && (
          <FinancialView
            items={items}
            sales={sales}
            onApplyRefunds={async (updates) => {
              try {
                await api.upsertItems(updates);
                const fresh = await api.getItems();
                applyItemsFresh(fresh);
                showToast(`Synced ${updates.length} refund${updates.length === 1 ? '' : 's'}`);
              } catch (e) {
                showToast(e.message || 'Refund sync failed', 'error');
              }
            }}
          />
        )}
        {activeTab === 'trash' && (
          <RecentlyDeletedView
            deletedItems={deletedItems}
            isAdmin={isAdmin}
            onRestore={async (ids) => {
              try {
                await api.restoreItems(ids);
                const fresh = await api.getItems();
                applyItemsFresh(fresh);
                showToast(`Restored ${ids.length} ${ids.length === 1 ? 'item' : 'items'}`);
              } catch (e) {
                showToast(e.message || 'Restore failed', 'error');
              }
            }}
            onPurge={(ids) => {
              if (!isAdmin) {
                showToast('Only admins can permanently delete items', 'error');
                return;
              }
              setConfirmDialog({
                title: `Delete ${ids.length} ${ids.length === 1 ? 'item' : 'items'} forever?`,
                message: 'This cannot be undone. The items will be permanently removed from the database.',
                confirmLabel: 'Delete forever',
                danger: true,
                onConfirm: async () => {
                  try {
                    await api.purgeItems(ids);
                    const fresh = await api.getItems();
                    applyItemsFresh(fresh);
                    showToast(`Purged ${ids.length} ${ids.length === 1 ? 'item' : 'items'}`);
                  } catch (e) {
                    showToast(e.message || 'Purge failed', 'error');
                  }
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
          varieties={varieties}
          species={species}
          onCreateVariety={addVariety}
          onCreateSpecies={addSpecies}
          onSave={(data) => { addItem(data); setShowAddModal(false); }}
          onClose={() => setShowAddModal(false)}
        />
      )}
      {showBatchModal && (
        <BatchVarietyModal
          existingItems={items}
          varieties={varieties}
          species={species}
          onCreateVariety={addVariety}
          onCreateSpecies={addSpecies}
          onSave={async (newItems) => {
            try {
              // Strip client IDs and timestamps — server generates them,
              // and server re-generates SKUs to guard against races.
              const clean = newItems.map(({ id, createdAt, createdBy, modifiedAt, modifiedBy, sku, ...rest }) => ({
                ...rest,
                status: rest.status || 'available',
              }));
              const before = new Set(items.map(i => i.id));
              await api.upsertItems(clean);
              const fresh = await api.getItems();
              applyItemsFresh(fresh);
              const sorted = [...fresh]
                .filter(i => !i.deletedAt)
                .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
              const justAdded = sorted.filter(i => !before.has(i.id));
              setShowBatchModal(false);
              if (justAdded.length > 0) {
                const firstSku = justAdded[justAdded.length - 1]?.sku;
                const lastSku = justAdded[0]?.sku;
                setAddSummary({
                  title: `Added ${justAdded.length} ${justAdded.length === 1 ? 'item' : 'items'}`,
                  detail: firstSku === lastSku ? firstSku : `${firstSku} → ${lastSku}`,
                  items: justAdded,
                });
              }
            } catch (e) {
              showToast(e.message || 'Failed to add items', 'error');
            }
          }}
          onClose={() => setShowBatchModal(false)}
        />
      )}
      {editingItem && (
        <ItemFormModal
          title="Edit SKU"
          sales={sales}
          item={editingItem}
          existingItems={items}
          varieties={varieties}
          species={species}
          onCreateVariety={addVariety}
          onCreateSpecies={addSpecies}
          onSave={(data) => { updateItem(editingItem.id, data); setEditingItem(null); }}
          onClose={() => setEditingItem(null)}
        />
      )}
      {showConvertModal && convertingItem && (
        <ConvertModal
          item={convertingItem}
          existingItems={items}
          varieties={varieties}
          species={species}
          onCreateVariety={addVariety}
          onCreateSpecies={addSpecies}
          onConvert={(data) => { convertToPlant(convertingItem.id, data); setShowConvertModal(false); setConvertingItem(null); }}
          onClose={() => { setShowConvertModal(false); setConvertingItem(null); }}
        />
      )}
      {showBulkModal && (
        <BulkImportModal
          onImport={async (newItems) => {
            try {
              const clean = newItems.map(({ id, createdAt, createdBy, modifiedAt, modifiedBy, ...rest }) => ({
                ...rest,
                status: rest.status || 'available',
              }));
              await api.upsertItems(clean);
              const fresh = await api.getItems();
              applyItemsFresh(fresh);
              showToast(`Imported ${clean.length} items`);
              setShowBulkModal(false);
            } catch (e) {
              showToast(e.message || 'Import failed', 'error');
            }
          }}
          onClose={() => setShowBulkModal(false)}
        />
      )}
      {showSaleModal && (
        <SaleFormModal
          onSave={async (data) => {
            try {
              await api.upsertSales([data]);
              const fresh = await api.getSales();
              setSales([...fresh].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)));
              showToast('Sale event created');
              setShowSaleModal(false);
            } catch (e) {
              showToast(e.message || 'Failed to create sale', 'error');
            }
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
                return { ...i, saleId: u.saleId, lotNumber: u.lotNumber, lotKind: u.lotKind };
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
      {uploadSale && (
        <SalesUploadModal
          sale={uploadSale}
          items={items}
          onApply={async (updates) => {
            try {
              await api.upsertItems(updates);
              const fresh = await api.getItems();
              applyItemsFresh(fresh);
              showToast(`Marked ${updates.length} ${updates.length === 1 ? 'item' : 'items'} sold`);
              setUploadSale(null);
            } catch (e) {
              showToast(e.message || 'Apply failed', 'error');
            }
          }}
          onClose={() => setUploadSale(null)}
        />
      )}
      {editingSale && (
        <SaleFormModal
          initial={editingSale}
          onSave={async (data) => {
            try {
              await api.upsertSales([data]);
              const fresh = await api.getSales();
              setSales([...fresh].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)));
              showToast('Sale event updated');
              setEditingSale(null);
            } catch (e) {
              showToast(e.message || 'Failed to update sale', 'error');
            }
          }}
          onClose={() => setEditingSale(null)}
        />
      )}
      {showCatalogModal && (
        <CatalogModal
          varieties={varieties}
          species={species}
          items={items}
          isAdmin={isAdmin}
          onVarietiesChange={setVarieties}
          onSpeciesChange={setSpecies}
          onClose={() => setShowCatalogModal(false)}
          showToast={showToast}
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

      {addSummary && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setAddSummary(null)}>
          <div className="bg-white rounded-xl w-full max-w-sm overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="p-5">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
                  <Check className="w-5 h-5 text-emerald-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900">{addSummary.title}</h3>
                  {addSummary.detail && (
                    <p className="text-sm text-gray-600 mt-1 font-mono truncate">{addSummary.detail}</p>
                  )}
                </div>
              </div>
            </div>
            <div className="bg-gray-50 px-5 py-3 flex justify-end gap-2">
              <button
                onClick={() => { setLabelItems(addSummary.items); setAddSummary(null); }}
                className="flex items-center gap-1.5 px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 hover:bg-gray-100 rounded-lg"
              >
                <Printer className="w-4 h-4" /> Print labels
              </button>
              <button
                onClick={() => setAddSummary(null)}
                className="px-4 py-2 text-sm text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
