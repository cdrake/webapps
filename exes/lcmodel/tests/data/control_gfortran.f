      program drv
c     Reference outputs of the pure CONTROL subprograms for control.rs tests.
      external ilen, icharst, igetp
      integer ilen, icharst, igetp
      character*40 s(12), t, split(2)*41, chi*6, comp*40
      real w(40), out(40)
      integer ibits(40)
      equivalence (w, ibits)
      data s /'  tumor', 'MUSCLE-1', '   ', 'abc  def ', ' x y z ',
     1  'out.table', 'dir/table', 'dir/ps', 'noext', 'a.PS',
     2  ' Liver-2 X', 'Q'/
      open (9, file='control_gfortran.txt')
      do 10 j = 1, 12
         t = s(j)
         call remove_blank_start(t)
         write (9, 5001) 'RBS', j, t
         t = s(j)
         call toupper_lower(.true., t)
         write (9, 5001) 'TUP', j, t
         t = s(j)
         call toupper_lower(.false., t)
         write (9, 5001) 'TLO', j, t
         write (9, 5002) 'ILEN', j, ilen(s(j)), icharst(s(j), 40)
         comp = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
         call compact_string(s(j), comp, lc)
         write (9, 5003) 'COMP', j, lc, comp
         call split_filename(s(j), 'table', 'TABLE', 'Table', 5, split)
         write (9, 5004) 'SPLT', j, split(1), split(2)
         call split_filename(s(j), 'ps', 'PS', 'Ps', 2, split)
         write (9, 5004) 'SPLP', j, split(1), split(2)
 10   continue
      do 20 j = -12, 12
         iarg = isign(3**iabs(j), j)
         if (iabs(j) .gt. 12) iarg = 0
         call chstrip_int6(iarg, chi, leni)
         write (9, 5005) 'CHS', iarg, leni, chi
 20   continue
      do 30 j = 1, 30
         istart = 7919 * j * j + 8829 * (j - 15)
         write (9, 5006) 'IGETP', istart, igetp(istart, 35),
     1                   igetp(istart, 59), igetp(istart + 3678, 41)
 30   continue
      do 40 j = 1, 40
         w(j) = sin(float(j)) * float(mod(j, 7))
         if (j .gt. 25) w(j) = (-1.)**j * (1. + .01 * float(j))
 40   continue
      call smooth_tail_2(w, out, 40, 40, 0, .false.)
      write (9, 5007) 'W', ibits
      do 50 j = 1, 40
         w(j) = out(j)
 50   continue
      write (9, 5007) 'OUT', ibits
 5001 format (a, i3, ' [', a, ']')
 5002 format (a, i3, 2i6)
 5003 format (a, i3, i4, ' [', a, ']')
 5004 format (a, i3, ' [', a, '] [', a, ']')
 5005 format (a, i8, i3, ' [', a, ']')
 5006 format (a, 4i12)
 5007 format (a / (5i12))
      end
