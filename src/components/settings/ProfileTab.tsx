import React from 'react';
import { Camera } from 'lucide-react';

export interface ProfileData {
  name: string;
  role: string;
  schoolName: string;
  email: string;
  phone: string;
  avatarUrl: string;
}

interface ProfileTabProps {
  profile: ProfileData;
  setProfile: React.Dispatch<React.SetStateAction<ProfileData>>;
}

export default function ProfileTab({ profile, setProfile }: ProfileTabProps) {
  return (
    <div className="bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800 rounded-3xl p-5 shadow-sm space-y-4">
      <div className="flex items-center gap-4 pb-3 border-b border-slate-100 dark:border-slate-800">
        <div className="relative">
          <img
            src={profile.avatarUrl}
            alt="Profile"
            className="h-16 w-16 rounded-2xl object-cover border-2 border-orange-500/50 shadow-md"
          />
          <button className="absolute -bottom-1 -right-1 bg-orange-500 text-white p-1 rounded-lg shadow">
            <Camera className="h-3 w-3" />
          </button>
        </div>
        <div>
          <h3 className="text-sm font-black">{profile.name}</h3>
          <p className="text-xs text-orange-500 font-bold">{profile.role}</p>
          <p className="text-[10px] text-slate-400 font-medium">{profile.schoolName}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-black text-slate-400 block mb-1">Full Name</label>
          <input
            type="text"
            value={profile.name}
            onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            className="w-full bg-slate-50 dark:bg-[#070b13] border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500"
          />
        </div>

        <div>
          <label className="text-[11px] font-black text-slate-400 block mb-1">Role / Designation</label>
          <input
            type="text"
            value={profile.role}
            onChange={(e) => setProfile({ ...profile, role: e.target.value })}
            className="w-full bg-slate-50 dark:bg-[#070b13] border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500"
          />
        </div>

        <div>
          <label className="text-[11px] font-black text-slate-400 block mb-1">Academy / School Name</label>
          <input
            type="text"
            value={profile.schoolName}
            onChange={(e) => setProfile({ ...profile, schoolName: e.target.value })}
            className="w-full bg-slate-50 dark:bg-[#070b13] border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500"
          />
        </div>

        <div>
          <label className="text-[11px] font-black text-slate-400 block mb-1">Contact WhatsApp</label>
          <input
            type="text"
            value={profile.phone}
            onChange={(e) => setProfile({ ...profile, phone: e.target.value })}
            className="w-full bg-slate-50 dark:bg-[#070b13] border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500"
          />
        </div>
      </div>
    </div>
  );
}
