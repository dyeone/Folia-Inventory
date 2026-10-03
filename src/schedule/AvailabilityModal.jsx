import { useState } from 'react';
import { Modal } from '../ui/Modal.jsx';
import { AvailabilityForm } from './AvailabilityForm.jsx';
import { mondayOf, todayStr, addDays, weekLabel } from './weekUtils.js';

// "My availability": this week and the next two, one tab each. Opened from
// the packing bench's top bar (team members) and the Schedule tab (admins).
export function AvailabilityModal({ onClose, onSaved }) {
  const thisWeek = mondayOf(todayStr());
  const weeks = [thisWeek, addDays(thisWeek, 7), addDays(thisWeek, 14)];
  const [week, setWeek] = useState(weeks[1]);   // next week is what the planner needs first
  return (
    <Modal title="My availability" onClose={onClose} size="lg">
      <div className="space-y-3">
        <div className="flex gap-1.5 flex-wrap">
          {weeks.map((w, i) => (
            <button
              key={w}
              type="button"
              onClick={() => setWeek(w)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${week === w ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}
            >
              {i === 0 ? 'This week' : i === 1 ? 'Next week' : 'In two weeks'} · {weekLabel(w).replace(/, \d{4}$/, '')}
            </button>
          ))}
        </div>
        <AvailabilityForm key={week} week={week} onSaved={onSaved} />
      </div>
    </Modal>
  );
}
